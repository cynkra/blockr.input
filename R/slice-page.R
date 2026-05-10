#' Apply single-column sort. Cycles handled JS-side; here we translate
#' the literal direction string.
#' @noRd
apply_sort <- function(data, col, dir) {
  if (is.null(col) || !nzchar(col)) return(data)
  if (is.null(dir) || dir %in% c("none", "")) return(data)
  if (dir == "asc")  return(dplyr::arrange(data, !!rlang::sym(col)))
  if (dir == "desc") return(dplyr::arrange(data, dplyr::desc(!!rlang::sym(col))))
  if (dir == "na") {
    return(dplyr::arrange(
      data,
      dplyr::desc(is.na(.data[[col]])),
      !!rlang::sym(col)
    ))
  }
  data
}

#' Filter rows where any character or factor column contains the query
#' (case-insensitive substring). Works on tibbles and dbplyr lazy tables
#' via `stringr::str_detect(..., regex(..., ignore_case = TRUE))`.
#' @noRd
apply_search <- function(data, query) {
  q <- trimws(query %||% "")
  if (!nzchar(q)) return(data)
  sample <- tryCatch(
    dplyr::collect(utils::head(data, 0L)),
    error = function(e) NULL
  )
  if (is.null(sample)) return(data)
  searchable <- names(sample)[vapply(sample, function(x) {
    is.character(x) || is.factor(x)
  }, logical(1))]
  if (length(searchable) == 0L) return(data)
  # Escape regex metas in the user's query — we want substring match.
  q_escaped <- gsub("([\\\\^$.|?*+()\\[\\]{}])", "\\\\\\1", q, perl = TRUE)
  preds <- lapply(searchable, function(col) {
    rlang::expr(stringr::str_detect(
      as.character(.data[[!!col]]),
      stringr::regex(!!q_escaped, ignore_case = TRUE)
    ))
  })
  combined <- Reduce(function(a, b) rlang::expr(!!a | !!b), preds)
  dplyr::filter(data, !!combined)
}

#' Slice one page from upstream after sort + search.
#' Returns a list with `rows` (tibble), `total_rows`, `page`, `page_size`,
#' `max_page`. Compatible with tibbles and dbplyr lazy tables (uses head +
#' tail which dbplyr translates to LIMIT + OFFSET).
#' @noRd
slice_page <- function(data, view = list()) {
  if (is.null(data)) {
    return(list(rows = tibble::tibble(), total_rows = 0L,
                page = 1L, page_size = 5L, max_page = 1L))
  }
  q <- data
  q <- apply_search(q, view$search %||% "")
  q <- apply_sort(q, view$sort_col %||% NULL, view$sort_dir %||% "none")

  total <- as.integer(
    dplyr::pull(dplyr::summarise(q, n = dplyr::n()), "n")
  )
  size <- as.integer(view$page_size %||%
                       getOption("blockr.input.page_size", 5L))
  size <- max(1L, size)
  max_page <- max(1L, as.integer(ceiling(total / size)))
  page <- as.integer(view$page %||% 1L)
  page <- max(1L, min(max_page, page))

  if (total == 0L) {
    rows <- tryCatch(
      dplyr::collect(utils::head(q, 0L)) |> tibble::as_tibble(),
      error = function(e) tibble::tibble()
    )
  } else {
    # On the last partial page we need fewer than `size` rows.
    take <- min(size, total - (page - 1L) * size)
    rows <- q |>
      utils::head(page * size) |>
      utils::tail(take) |>
      dplyr::collect() |>
      tibble::as_tibble()
  }

  list(
    rows       = rows,
    total_rows = total,
    page       = page,
    page_size  = size,
    max_page   = max_page
  )
}
