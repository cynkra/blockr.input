#' Grid block (JS-driven multi-row data entry)
#'
#' A transform block that renders the upstream tibble as an editable grid
#' (Tabulator-backed). The user pastes / types / edits rows; the block
#' emits a tibble matching the upstream's column structure with the grid's
#' current row set.
#'
#' Connecting a 0-row tibble upstream gives a "blank entry" mode with one
#' empty row pre-rendered for typing.
#'
#' Different from [new_edit_block()]: the grid replaces the row set
#' wholesale — there are no surgical `rows_upsert` / `rows_delete` semantics
#' and no key column. Use the edit block for surgical edits to a large
#' keyed tibble; use the grid block for bulk entry on a small tibble.
#'
#' @param state The block's persisted state. Recognised fields:
#'   - `rows` (list of named lists): the grid's current row set. Each row's
#'     names match upstream's column names. Empty by default.
#' @param ... Forwarded to [blockr.core::new_transform_block()].
#'
#' @return A blockr block of class `grid_block`.
#'
#' @examples
#' if (interactive()) {
#'   library(blockr.core)
#'   serve(
#'     new_grid_block(),
#'     data = list(data = head(iris, 0)) # 0-row schema for blank entry
#'   )
#' }
#'
#' @export
new_grid_block <- function(state = list(rows = list()), ...) {
  blockr.core::new_transform_block(
    server = function(id, data) {
      shiny::moduleServer(id, function(input, output, session) {
        ns <- session$ns
        r_state <- shiny::reactiveVal(state)

        self_write <- new.env(parent = emptyenv())
        self_write$active <- FALSE

        # Push column meta on every upstream-data change.
        # Seed rows only on first hydration (when state is empty); after
        # the user has been editing, send seed = NULL to keep their work.
        shiny::observeEvent(data(), {
          d <- data()
          meta <- build_column_meta(d)
          rows_now <- r_state()$rows %||% list()
          seed <- if (length(rows_now) > 0L) {
            NULL                  # don't reseed
          } else if (!is.null(d) && nrow(d) > 0L) {
            tibble_to_row_list(d) # hydrate from upstream
          } else if (length(meta) > 0L) {
            list(empty_row(meta)) # one blank row for fresh entry
          } else {
            NULL
          }
          session$sendCustomMessage(
            "grid-columns",
            list(
              id        = ns("grid_input"),
              columns   = meta,
              seed_rows = seed
            )
          )
        }, ignoreNULL = FALSE)

        # JS -> R
        shiny::observeEvent(input$grid_input, {
          self_write$active <- TRUE
          r_state(input$grid_input)
        })

        # R -> JS (external control: programmatic state changes)
        shiny::observeEvent(r_state(), {
          if (self_write$active) {
            self_write$active <- FALSE
          } else {
            session$sendCustomMessage(
              "grid-block-update",
              list(
                id    = ns("grid_input"),
                state = normalize_grid_state_for_js(r_state())
              )
            )
          }
        }, ignoreInit = TRUE)

        list(
          expr  = shiny::reactive(make_grid_expr(r_state(), data())),
          state = list(state = r_state)
        )
      })
    },
    ui = function(id) {
      htmltools::tagList(
        blockr.dplyr::blockr_core_js_dep(),
        blockr.dplyr::blockr_blocks_css_dep(),
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
    class = "grid_block",
    expr_type = "bquoted",
    external_ctrl = TRUE,
    allow_empty_state = "state",
    ...
  )
}
