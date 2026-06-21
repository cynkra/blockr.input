#' Grid entry block (JS-driven multi-row data entry over an upstream tibble)
#'
#' A transform block that renders the upstream tibble as an editable grid
#' (Tabulator-backed). The user pastes / types / edits rows / deletes rows;
#' the block composes [dplyr::rows_upsert()] and [dplyr::rows_delete()]
#' against upstream using a key column the builder picks via the cogwheel.
#'
#' Connecting a 0-row tibble upstream gives a "blank entry" mode where every
#' grid row becomes an insert.
#'
#' Same generated-code shape as [new_form_edit_block()]; the difference is the
#' UI — grid for bulk entry vs. row-picker + form for surgical edits.
#'
#' @param key_col character(1): name of the upstream column used to identify
#'   rows. If `NULL`, auto-picked on first hydration (first column whose values
#'   are all unique).
#' @param upserts list of named lists: pending inserts/updates.
#' @param deletes list/character: pending key values to delete.
#' @param ... Forwarded to [blockr.core::new_transform_block()].
#'
#' @return A blockr block of class `grid_edit_block`.
#'
#' @examples
#' if (interactive()) {
#'   library(blockr.core)
#'   serve(
#'     new_grid_edit_block(),
#'     data = list(data = head(iris, 0))
#'   )
#' }
#'
#' @export
new_grid_edit_block <- function(
  key_col = NULL,
  upserts = list(),
  deletes = list(),
  ...
) {
  blockr.core::new_transform_block(
    server = function(id, data) {
      shiny::moduleServer(id, function(input, output, session) {
        ns <- session$ns

        st <- js_block_state(
          input, session,
          name       = "grid",
          input_name = "grid_input",
          state = list(key_col = key_col, upserts = upserts, deletes = deletes),
          normalize_state = normalize_grid_state_for_js,
          ignore_init = TRUE
        )

        # One message carries both columns and rows. Earlier we split them
        # across grid-columns + grid-rows, but grid-rows gated on
        # r_state$key_col which JS sets without telling R first; the result
        # was that upstream rows never reached the grid.
        shiny::observeEvent(data(), {
          d <- data()

          # Hard guard: lazy tables don't belong here. The grid loads every
          # row into the browser; for a lazy table that's either impossible
          # or wasteful. Surface the error and stop.
          if (!is.null(d) && inherits(d, "tbl_lazy")) {
            session$sendCustomMessage("grid-banner", list(
              id      = ns("grid_input"),
              level   = "error",
              message = paste(
                "Grid Edit doesn't support remote (dbplyr) tables.",
                "Use the Table Edit block instead."
              )
            ))
            return()
          }

          # Wait for a proper data frame. During reactive init or workflow
          # reload, `data()` can fire with NULL or an empty list before the
          # upstream resolves. nrow() returns NULL for non-frame inputs,
          # which breaks `if (n > max_rows)` downstream.
          if (!is.data.frame(d)) {
            return()
          }

          # Soft guard: large in-memory tables work but slow down the
          # browser. Threshold tunable via `blockr.input.grid_max_rows`.
          n <- nrow(d)
          max_rows <- getOption("blockr.input.grid_max_rows", 5000L)
          if (n > max_rows) {
            session$sendCustomMessage("grid-banner", list(
              id      = ns("grid_input"),
              level   = "warning",
              message = sprintf(
                paste(
                  "Grid Edit has %s rows loaded into the browser",
                  "(soft limit %s). Consider the Table Edit block for",
                  "larger tables."
                ),
                format(n, big.mark = ","),
                format(max_rows, big.mark = ",")
              )
            ))
          } else {
            session$sendCustomMessage("grid-banner", list(
              id      = ns("grid_input"),
              level   = "ok",
              message = ""
            ))
          }

          meta <- build_column_meta(d)
          rows <- tibble_to_row_list(d)
          rows_pending <- length(st$state()$upserts %||% list()) > 0L
          seed_blank <- !rows_pending && n == 0L && length(meta) > 0L
          session$sendCustomMessage(
            "grid-columns",
            list(
              id         = ns("grid_input"),
              columns    = meta,
              rows       = rows,
              seed_blank = seed_blank
            )
          )
        }, ignoreNULL = FALSE)

        # Note: key_col auto-pick happens in JS (see grid-block.js
        # updateColumns). JS keys upstream rows by the picked column;
        # subsequent state pushes (R <- JS via the input binding) carry
        # key_col so server-side make_grid_expr knows which column to
        # rows_upsert / rows_delete by.

        list(
          expr  = shiny::reactive(make_grid_expr(st$state(), upstream = data())),
          state = st$fields
        )
      })
    },
    ui = function(id) {
      htmltools::tagList(
        blockr.dplyr::blockr_core_js_dep(),
        blockr.dplyr::blockr_blocks_css_dep(),
        blockr.dplyr::blockr_select_dep(),
        grid_block_dep(),
        shiny::div(
          class = "block-container",
          shiny::div(
            id    = shiny::NS(id, "grid_input"),
            class = "grid-block-container"
          )
        )
      )
    },
    class = "grid_edit_block",
    expr_type = "bquoted",
    external_ctrl = TRUE,
    allow_empty_state = TRUE,
    ...
  )
}
