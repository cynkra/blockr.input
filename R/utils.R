`%||%` <- function(x, y) if (is.null(x)) y else x

col_type <- function(x) {
  if (is.factor(x)) return("factor")
  if (inherits(x, "Date")) return("date")
  if (inherits(x, "POSIXt")) return("datetime")
  if (is.logical(x)) return("lgl")
  if (is.integer(x)) return("int")
  if (is.numeric(x)) return("dbl")
  "chr"
}

build_column_meta <- function(df) {
  if (is.null(df) || ncol(df) == 0L) return(list())
  nms <- colnames(df)
  lapply(seq_along(df), function(i) {
    col <- df[[i]]
    n <- length(col)
    n_uniq <- if (n == 0L) 0L else dplyr::n_distinct(col, na.rm = TRUE)
    choices <- if (is.factor(col)) {
      as.list(levels(col))
    } else if (is.character(col) && n_uniq > 0L && n_uniq <= 20L) {
      as.list(sort(unique(stats::na.omit(col))))
    } else {
      NULL
    }
    list(
      name         = nms[i],
      type         = col_type(col),
      choices      = choices,
      unique_count = n_uniq,
      n_rows       = n
    )
  })
}

build_row_options <- function(df, key, display_cols = list()) {
  if (is.null(df) || !key %in% colnames(df) || nrow(df) == 0L) return(list())
  keys <- df[[key]]
  display_cols <- unlist(display_cols)
  display_cols <- display_cols[display_cols %in% colnames(df) & display_cols != key]
  labels <- if (length(display_cols)) {
    parts <- df[, display_cols, drop = FALSE]
    apply(parts, 1L, function(r) paste(as.character(r), collapse = ", "))
  } else {
    as.character(keys)
  }
  full_labels <- if (length(display_cols)) {
    paste0(as.character(keys), " — ", labels)
  } else {
    labels
  }
  lapply(seq_len(nrow(df)), function(i) {
    row_vals <- as.list(df[i, , drop = FALSE])
    # JSON-friendly: dates / factors / POSIXct → strings the JS editors
    # know how to display and round-trip.
    row_vals <- setNames(lapply(row_vals, jsonable), names(row_vals))
    list(
      key    = jsonable(keys[[i]]),
      label  = full_labels[[i]],
      values = row_vals
    )
  })
}

normalize_edit_state_for_js <- function(state) {
  if (is.null(state)) return(state)
  state$display_cols  <- as.list(state$display_cols  %||% character())
  state$editable_cols <- as.list(state$editable_cols %||% character())
  state$deletes       <- as.list(state$deletes       %||% character())
  state
}

# Grid-block helpers ----------------------------------------------------------

# JSON-friendly value: dates / factors / POSIXct → ISO strings.
jsonable <- function(x) {
  if (length(x) == 0L) return(NA)
  v <- x[[1L]]
  if (is.null(v) || (length(v) == 1L && is.na(v))) return(NA)
  if (inherits(v, "Date")) return(format(v, "%Y-%m-%d"))
  if (inherits(v, "POSIXt")) return(format(v, "%Y-%m-%dT%H:%M:%S"))
  if (is.factor(v)) return(as.character(v))
  if (is.logical(v)) return(v)
  if (is.numeric(v)) return(v)
  as.character(v)
}

# Convert a tibble to a list of named lists, one per row, JSON-ready.
tibble_to_row_list <- function(df) {
  if (is.null(df) || nrow(df) == 0L) return(list())
  nms <- colnames(df)
  lapply(seq_len(nrow(df)), function(i) {
    row <- as.list(df[i, , drop = FALSE])
    setNames(lapply(row, jsonable), nms)
  })
}

# A blank row matching the schema's column structure.
empty_row <- function(meta) {
  if (length(meta) == 0L) return(list())
  setNames(
    as.list(rep("", length(meta))),
    vapply(meta, function(c) c$name, character(1))
  )
}

# Cast a character vector to a target R type per the column meta.
# Throws on irrecoverable mismatch; JS validators should have caught it first.
cast_to_type <- function(x, type, choices = NULL) {
  if (length(x) == 0L) return(switch(type,
    int    = integer(),
    dbl    = numeric(),
    chr    = character(),
    lgl    = logical(),
    date   = as.Date(character()),
    factor = factor(character(), levels = unlist(choices, use.names = FALSE)),
    character()
  ))
  na_idx <- is.na(x) | x == "" | x == "NA"
  switch(type,
    int = {
      out <- suppressWarnings(as.integer(x))
      out[na_idx] <- NA_integer_
      out
    },
    dbl = {
      out <- suppressWarnings(as.numeric(x))
      out[na_idx] <- NA_real_
      out
    },
    chr = {
      out <- as.character(x)
      out[na_idx] <- NA_character_
      out
    },
    lgl = {
      lower <- tolower(x)
      out <- ifelse(lower %in% c("true", "t", "yes", "1"), TRUE,
             ifelse(lower %in% c("false", "f", "no", "0"), FALSE, NA))
      as.logical(out)
    },
    date = {
      out <- suppressWarnings(as.Date(x))
      out[na_idx] <- NA
      out
    },
    factor = {
      lvls <- unlist(choices, use.names = FALSE)
      out <- factor(x, levels = lvls)
      out[na_idx] <- NA
      out
    },
    {
      out <- as.character(x)
      out[na_idx] <- NA_character_
      out
    }
  )
}

# Build a typed tibble from a list of named lists + column meta.
build_tibble_from_state <- function(rows, meta) {
  if (length(meta) == 0L) return(tibble::tibble())
  nms <- vapply(meta, function(c) c$name, character(1))
  cols <- lapply(meta, function(c) {
    raw <- vapply(rows, function(r) {
      v <- r[[c$name]]
      if (is.null(v)) NA_character_ else as.character(v)
    }, character(1))
    cast_to_type(raw, c$type, c$choices)
  })
  names(cols) <- nms
  tibble::as_tibble(cols)
}

# Wrap length-1 character vectors with as.list() so JSON's auto_unbox does
# not collapse them to scalars (per feedback_shiny_auto_unbox_js).
normalize_grid_state_for_js <- function(state) {
  if (is.null(state)) return(state)
  state$upserts <- state$upserts %||% list()
  state$deletes <- as.list(state$deletes %||% character())
  state
}

# Cast a vector to the same R type as `template`. Used so JS-side string
# values flow back into the right column type before rows_upsert / rows_delete.
cast_to_match <- function(x, template) {
  if (is.factor(template)) {
    return(factor(as.character(x), levels = levels(template)))
  }
  if (inherits(template, "Date")) return(as.Date(as.character(x)))
  if (inherits(template, "POSIXct")) return(as.POSIXct(as.character(x)))
  if (is.integer(template)) return(suppressWarnings(as.integer(x)))
  if (is.numeric(template)) return(suppressWarnings(as.numeric(x)))
  if (is.logical(template)) return(as.logical(x))
  as.character(x)
}

# Cast each column of `tbl` to match the corresponding column of `template_df`
# where present. Columns absent from template_df pass through unchanged.
cast_tbl_to_match <- function(tbl, template_df) {
  if (is.null(template_df) || ncol(template_df) == 0L) return(tbl)
  for (nm in intersect(colnames(tbl), colnames(template_df))) {
    tbl[[nm]] <- cast_to_match(tbl[[nm]], template_df[[nm]])
  }
  tbl
}

# Build a typed tibble from a list of named lists (one per upsert row),
# column-by-column. Column types are taken from `template_df`. Empty
# strings and NULL become NA of the appropriate type. Avoids the
# bind_rows("Can't combine <int> and <chr>") trap that occurs when one
# row's value is empty (parsed as character by as_tibble_row).
build_upserts_tbl <- function(rows, template_df) {
  if (length(rows) == 0L) return(tibble::tibble())
  if (is.null(template_df) || ncol(template_df) == 0L) {
    # No type guidance — fall back to plain bind_rows.
    return(dplyr::bind_rows(lapply(rows, tibble::as_tibble_row)))
  }
  cols <- list()
  for (nm in colnames(template_df)) {
    raw <- vapply(rows, function(r) {
      v <- r[[nm]]
      if (is.null(v) || identical(v, "")) NA_character_
      else as.character(v)
    }, character(1))
    cols[[nm]] <- cast_to_match(raw, template_df[[nm]])
  }
  tibble::as_tibble(cols)
}
