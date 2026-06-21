#' @importFrom blockr.core register_blocks
register_blocks_internal <- function() {
  register_blocks(
    "new_form_edit_block",
    name = "Form Edit",
    description = paste0(
      "Pick a row from the upstream table by a key column, edit values, ",
      "add new rows, or delete rows. Composes dplyr::rows_upsert and ",
      "dplyr::rows_delete."
    ),
    category = "transform",
    arguments = list(form_edit_arguments()),
    package = "blockr.input",
    overwrite = TRUE
  )
  register_blocks(
    "new_grid_edit_block",
    name = "Grid Edit",
    description = paste0(
      "Multi-row data entry as an editable grid (Tabulator). Upstream ",
      "tibble defines the schema; the grid's rows replace the upstream ",
      "row set. Paste-from-Excel as the primary entry path."
    ),
    category = "transform",
    arguments = list(grid_edit_arguments()),
    package = "blockr.input",
    overwrite = TRUE
  )
  register_blocks(
    "new_table_edit_block",
    name = "Table Edit",
    description = paste0(
      "Server-paginated browse-and-edit over a tibble or dbplyr lazy ",
      "table. Sort, search, page; pending edits visible above the page; ",
      "composes dplyr::rows_upsert and dplyr::rows_delete on Apply."
    ),
    category = "transform",
    arguments = list(table_edit_arguments()),
    package = "blockr.input",
    overwrite = TRUE
  )
}
