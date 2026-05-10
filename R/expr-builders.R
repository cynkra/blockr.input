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
#' Same shape as `make_edit_expr`: composes `dplyr::rows_delete()` then
#' `dplyr::rows_upsert()` against upstream, using the user-picked key
#' column. JS computes the diff (which rows are new / changed / removed)
#' against the upstream snapshot and pushes the resulting `upserts` and
#' `deletes` lists. Pass-through if there is no key column or nothing to
#' apply.
#'
#' Casts the JS-side string values back to upstream's column types
#' (Date / factor / int / etc.) before inlining, so `dplyr::rows_upsert`
#' doesn't error on type mismatch.
#'
#' @param state The block state list. Recognised fields: `key_col`,
#'   `upserts`, `deletes`.
#' @param upstream The current upstream tibble — used to coerce upserts and
#'   delete-keys to upstream's column types. Named `upstream` not `data`
#'   on purpose: `bbquote(.(data))` needs `data` to remain a placeholder
#'   symbol, not a function argument.
#'
#' @return A `bbquoted` language object.
#'
#' @noRd
make_grid_expr <- function(state, upstream = NULL) {
  key     <- state$key_col
  upserts <- state$upserts %||% list()
  deletes <- state$deletes %||% list()

  if (is.null(key) || !nzchar(key) ||
      (length(upserts) == 0L && length(deletes) == 0L)) {
    return(blockr.core::bbquote(.(data)))
  }

  stmts <- list(quote(.x <- .(data)))

  if (length(deletes) > 0L) {
    key_vals <- unlist(deletes, use.names = FALSE)
    if (!is.null(upstream) && key %in% colnames(upstream)) {
      key_vals <- cast_to_match(key_vals, upstream[[key]])
    }
    deletes_tbl <- tibble::tibble(!!key := key_vals)
    stmts <- c(stmts, list(blockr.core::bbquote(
      .x <- dplyr::rows_delete(.x, .(d), by = .(k)),
      list(d = deletes_tbl, k = key)
    )))
  }

  if (length(upserts) > 0L) {
    upserts_tbl <- dplyr::bind_rows(lapply(upserts, tibble::as_tibble_row))
    if (!is.null(upstream)) {
      upserts_tbl <- cast_tbl_to_match(upserts_tbl, upstream)
    }
    stmts <- c(stmts, list(blockr.core::bbquote(
      .x <- dplyr::rows_upsert(.x, .(u), by = .(k)),
      list(u = upserts_tbl, k = key)
    )))
  }

  stmts <- c(stmts, list(quote(.x)))
  expr  <- as.call(c(list(quote(`{`)), stmts))
  blockr.core::bbquote(.(expr), list(expr = expr))
}
