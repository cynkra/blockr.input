#' Edit block (JS-driven CRUD over an upstream tibble)
#'
#' A transform block that lets the end user pick a row from the upstream tibble
#' (by a key column), edit values, add new rows, or delete rows. Output is the
#' upstream tibble with those operations applied via [dplyr::rows_upsert()] and
#' [dplyr::rows_delete()].
#'
#' Connecting a 0-row tibble upstream gives a "blank entry" mode where only the
#' insert path is exercised.
#'
#' @param state The block's persisted state. Recognised fields:
#'   - `key_col` (character(1)): name of the upstream column used to identify
#'     rows. Required before any operation can be applied.
#'   - `display_cols` (list/character): optional extra columns shown in the row
#'     picker label, alongside the key.
#'   - `editable_cols` (list/character): columns the user can edit / fill in
#'     for new rows. Defaults to all non-key columns.
#'   - `upserts` (list of named lists): pending inserts/updates. Each entry
#'     carries `key + editable_cols`.
#'   - `deletes` (list/character): pending key values to delete.
#' @param ... Forwarded to [blockr.core::new_transform_block()].
#'
#' @return A blockr block of class `edit_block`.
#'
#' @examples
#' if (interactive()) {
#'   library(blockr.core)
#'   serve(
#'     new_edit_block(state = list(key_col = "Species")),
#'     data = list(data = iris)
#'   )
#' }
#'
#' @export
new_edit_block <- function(
  state = list(
    key_col = NULL,
    display_cols = list(),
    editable_cols = list(),
    upserts = list(),
    deletes = list()
  ),
  ...
) {
  blockr.core::new_transform_block(
    server = function(id, data) {
      shiny::moduleServer(id, function(input, output, session) {
        ns <- session$ns
        r_state <- shiny::reactiveVal(state)

        self_write <- new.env(parent = emptyenv())
        self_write$active <- FALSE

        # Push column metadata to JS whenever the upstream changes
        shiny::observeEvent(data(), {
          session$sendCustomMessage(
            "edit-columns",
            list(
              id      = ns("edit_input"),
              columns = build_column_meta(data())
            )
          )
        }, ignoreNULL = FALSE)

        # Push row options (key + composed label) when upstream OR cogwheel changes
        shiny::observe({
          d <- data()
          s <- r_state()
          key <- s$key_col
          if (is.null(d) || is.null(key) || !nzchar(key)) return()
          if (!key %in% colnames(d)) return()
          session$sendCustomMessage(
            "edit-rows",
            list(
              id   = ns("edit_input"),
              rows = build_row_options(d, key, s$display_cols)
            )
          )
        })

        # JS -> R
        shiny::observeEvent(input$edit_input, {
          self_write$active <- TRUE
          r_state(input$edit_input)
        })

        # R -> JS (initial state push + external control updates).
        # No `ignoreInit`: the initial r_state() value must reach the JS so
        # the form renders for the configured key_col / editable_cols.
        shiny::observeEvent(r_state(), {
          if (self_write$active) {
            self_write$active <- FALSE
          } else {
            session$sendCustomMessage(
              "edit-block-update",
              list(
                id    = ns("edit_input"),
                state = normalize_edit_state_for_js(r_state())
              )
            )
          }
        })

        list(
          expr  = shiny::reactive(make_edit_expr(r_state())),
          state = list(state = r_state)
        )
      })
    },
    ui = function(id) {
      htmltools::tagList(
        blockr.dplyr::blockr_core_js_dep(),
        blockr.dplyr::blockr_blocks_css_dep(),
        blockr.dplyr::blockr_select_dep(),
        blockr.dplyr::blockr_input_dep(),
        edit_block_dep(),
        shiny::div(
          class = "block-container",
          shiny::div(
            id    = shiny::NS(id, "edit_input"),
            class = "edit-block-container"
          )
        )
      )
    },
    class = "edit_block",
    expr_type = "bquoted",
    external_ctrl = TRUE,
    allow_empty_state = "state",
    ...
  )
}
