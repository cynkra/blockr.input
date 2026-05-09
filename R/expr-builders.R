#' Build the edit block's bquoted expression
#'
#' Composes `dplyr::rows_delete()` then `dplyr::rows_upsert()` based on the
#' state's `deletes` and `upserts`. Returns a pass-through if there is nothing
#' to apply or no key column has been set.
#'
#' @param state The block state list. Recognised fields: `key_col`, `upserts`,
#'   `deletes`.
#'
#' @return A `bbquoted` language object.
#'
#' @noRd
make_edit_expr <- function(state) {
  key     <- state$key_col
  upserts <- state$upserts %||% list()
  deletes <- state$deletes %||% list()

  if (is.null(key) || !nzchar(key) ||
      (length(upserts) == 0L && length(deletes) == 0L)) {
    return(blockr.core::bbquote(.(data)))
  }

  stmts <- list(quote(.x <- .(data)))

  if (length(deletes) > 0L) {
    deletes_tbl <- tibble::tibble(!!key := unlist(deletes, use.names = FALSE))
    stmts <- c(stmts, list(blockr.core::bbquote(
      .x <- dplyr::rows_delete(.x, .(d), by = .(k)),
      list(d = deletes_tbl, k = key)
    )))
  }

  if (length(upserts) > 0L) {
    upserts_tbl <- dplyr::bind_rows(lapply(upserts, tibble::as_tibble_row))
    stmts <- c(stmts, list(blockr.core::bbquote(
      .x <- dplyr::rows_upsert(.x, .(u), by = .(k)),
      list(u = upserts_tbl, k = key)
    )))
  }

  stmts <- c(stmts, list(quote(.x)))
  expr  <- as.call(c(list(quote(`{`)), stmts))
  blockr.core::bbquote(.(expr), list(expr = expr))
}

#' Build the grid block's bquoted expression
#'
#' Inlines the grid's current rows as a typed tibble. Empty grid → 0-row
#' tibble preserving the upstream column structure (so downstream blocks
#' don't break on missing columns). Type-cast failure → same pass-through.
#'
#' @param state The block state list with field `rows` (list of named lists).
#' @param data The current upstream tibble (for column meta).
#'
#' @return A `bbquoted` language object.
#'
#' @noRd
make_grid_expr <- function(state, data) {
  rows <- state$rows %||% list()

  empty_pass_through <- function(d) {
    blockr.core::bbquote(.(d)[0L, , drop = FALSE], list(d = d))
  }

  if (is.null(data) || ncol(data) == 0L || length(rows) == 0L) {
    return(empty_pass_through(data %||% tibble::tibble()))
  }

  meta <- build_column_meta(data)
  out_tbl <- tryCatch(
    build_tibble_from_state(rows, meta),
    error = function(e) NULL
  )

  if (is.null(out_tbl)) return(empty_pass_through(data))

  blockr.core::bbquote(.(out), list(out = out_tbl))
}
