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
    list(
      key    = keys[[i]],
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

# Hook for future auto_unbox traps; v1 is a pass-through.
normalize_grid_state_for_js <- function(state) {
  if (is.null(state)) return(state)
  state$rows <- state$rows %||% list()
  state
}
