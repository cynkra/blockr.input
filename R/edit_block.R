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
#' @param key_col character(1): name of the upstream column used to identify
#'   rows. Required before any operation can be applied.
#' @param display_cols list/character: optional extra columns shown in the row
#'   picker label, alongside the key.
#' @param editable_cols list/character: columns the user can edit / fill in for
#'   new rows. Defaults to all non-key columns.
#' @param upserts list of named lists: pending inserts/updates. Each entry
#'   carries `key + editable_cols`.
#' @param deletes list/character: pending key values to delete.
#' @param ... Forwarded to [blockr.core::new_transform_block()].
#'
#' @return A blockr block of class `form_edit_block`.
#'
#' @examples
#' if (interactive()) {
#'   library(blockr.core)
#'   serve(
#'     new_form_edit_block(key_col = "Species"),
#'     data = list(data = iris)
#'   )
#' }
#'
#' @export
new_form_edit_block <- function(
  key_col = NULL,
  display_cols = list(),
  editable_cols = list(),
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
          name       = "edit",
          input_name = "edit_input",
          state = list(
            key_col       = key_col,
            display_cols  = display_cols,
            editable_cols = editable_cols,
            upserts       = upserts,
            deletes       = deletes
          ),
          normalize_state = normalize_edit_state_for_js,
          # Initial state must reach JS so the form renders for the configured
          # key_col / editable_cols (hence no ignore_init).
          ignore_init = FALSE
        )

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
          s <- st$state()
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

        list(
          expr  = shiny::reactive(make_edit_expr(st$state())),
          state = st$fields
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
    class = "form_edit_block",
    expr_type = "bquoted",
    external_ctrl = TRUE,
    allow_empty_state = TRUE,
    ...
  )
}
