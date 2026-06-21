#' blockr.input: Interactive data-entry blocks for blockr
#'
#' Extends 'blockr.core' with blocks that let an end user edit data inside a
#' running dashboard: [new_form_edit_block()] for
#' row-level edits, [new_grid_edit_block()] for spreadsheet-style bulk entry,
#' and [new_table_edit_block()] for server-paginated browse-and-edit. Each
#' emits ordinary `dplyr::rows_upsert()` / `dplyr::rows_delete()` steps.
#'
#' @keywords internal
"_PACKAGE"

# NSE symbols used inside the dplyr pipelines emitted by the expr builders
# (make_edit_expr / make_grid_expr / make_table_expr) and the server-side
# sort / search helpers - declared so R CMD check does not flag them as
# undefined global variables.
utils::globalVariables(c(
  ".", ".data", ":=", "d", "k", "u", "data"
))
