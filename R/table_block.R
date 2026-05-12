#' Table block (server-paginated CRUD over an upstream table)
#'
#' A transform block that browses a tibble or dbplyr lazy table one
#' page at a time, with sort and global search resolved on the R side.
#' Pending edits (upserts and deletes) are accumulated in a JS-side
#' "pending changes" strip that stays visible regardless of which page
#' the user is on; on Apply the block emits
#' `data |> dplyr::rows_delete(...) |> dplyr::rows_upsert(...)`.
#'
#' Unlike [new_grid_block()] this block does NOT load the full upstream
#' into the browser; only the current page slice round-trips to JS, so
#' it works on tens-of-thousands-of-rows tibbles and on dbplyr lazy
#' tables without `collect()`.
#'
#' @param state The persisted state. Recognised fields:
#'   - `key_col` (character(1)): name of the upstream column used to
#'     identify rows. Auto-picked on first hydration if `NULL`.
#'   - `upserts` (list of named lists): pending inserts/updates.
#'   - `deletes` (list/character): pending key values to delete.
#' @param ... Forwarded to [blockr.core::new_transform_block()].
#'
#' @return A blockr block of class `table_block`.
#'
#' @examples
#' if (interactive()) {
#'   library(blockr.core)
#'   serve(new_table_block(), data = list(data = head(iris, 30)))
#' }
#'
#' @export
new_table_block <- function(
  state = list(
    key_col = NULL,
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
        r_view  <- shiny::reactiveVal(list(
          page = 1L,
          page_size = getOption("blockr.input.page_size", 5L),
          sort_col = NULL,
          sort_dir = "none",
          search = "",
          pending_only = FALSE,
          pending_keys = list(),
          key_col = ""
        ))

        self_write <- new.env(parent = emptyenv())
        self_write$active <- FALSE

        send_page <- function(d, view, with_columns = FALSE) {
          if (is.null(d)) return()
          page <- slice_page(d, view)
          msg <- list(
            id           = ns("table_input"),
            rows         = tibble_to_row_list(page$rows),
            total_rows   = page$total_rows,
            page         = page$page,
            page_size    = page$page_size,
            max_page     = page$max_page,
            pending_only = page$pending_only
          )
          if (with_columns) {
            sample <- tryCatch(
              dplyr::collect(utils::head(d, 0L)),
              error = function(e) NULL
            )
            if (!is.null(sample)) msg$columns <- build_column_meta(sample)
          }
          session$sendCustomMessage("table-page", msg)
        }

        # Push columns + first page on every upstream change.
        shiny::observeEvent(data(), {
          send_page(data(), r_view(), with_columns = TRUE)
        }, ignoreNULL = FALSE)

        # JS -> R: view changed (page / sort / search / pending-only).
        shiny::observeEvent(input$table_view, {
          v <- input$table_view
          # Coerce numerics — Shiny sends them as plain values but
          # JSON could deliver as character via certain bindings.
          v$page      <- as.integer(v$page %||% 1L)
          v$page_size <- as.integer(v$page_size %||%
            getOption("blockr.input.page_size", 5L))
          v$search   <- as.character(v$search %||% "")
          v$sort_col <- if (is.null(v$sort_col) || identical(v$sort_col, "")) {
            NULL
          } else {
            as.character(v$sort_col)
          }
          v$sort_dir     <- as.character(v$sort_dir %||% "none")
          v$pending_only <- isTRUE(v$pending_only)
          v$key_col      <- as.character(v$key_col %||% "")
          v$pending_keys <- as.list(v$pending_keys %||% list())
          r_view(v)
          send_page(data(), v, with_columns = FALSE)
        })

        # JS -> R: pending state changes
        shiny::observeEvent(input$table_input, {
          self_write$active <- TRUE
          r_state(input$table_input)
        })

        # R -> JS: external state restore (workflow reload)
        shiny::observeEvent(r_state(), {
          if (self_write$active) {
            self_write$active <- FALSE
          } else {
            session$sendCustomMessage("table-block-update", list(
              id    = ns("table_input"),
              state = normalize_grid_state_for_js(r_state())
            ))
          }
        }, ignoreInit = TRUE)

        list(
          expr  = shiny::reactive(make_table_expr(r_state(), upstream = data())),
          state = list(state = r_state)
        )
      })
    },
    ui = function(id) {
      htmltools::tagList(
        blockr.dplyr::blockr_core_js_dep(),
        blockr.dplyr::blockr_blocks_css_dep(),
        blockr.dplyr::blockr_select_dep(),
        table_block_dep(),
        shiny::div(
          class = "block-container",
          shiny::div(
            id    = shiny::NS(id, "table_input"),
            class = "table-block-container"
          )
        )
      )
    },
    class = "table_block",
    expr_type = "bquoted",
    external_ctrl = TRUE,
    allow_empty_state = "state",
    ...
  )
}
