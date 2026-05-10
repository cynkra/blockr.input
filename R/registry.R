#' @importFrom blockr.core register_blocks
register_blocks_internal <- function() {
  register_blocks(
    "new_edit_block",
    name = "Edit Rows",
    description = paste0(
      "Pick a row from the upstream table by a key column, edit values, ",
      "add new rows, or delete rows. Composes dplyr::rows_upsert and ",
      "dplyr::rows_delete."
    ),
    category = "transform",
    package = "blockr.input"
  )
  register_blocks(
    "new_grid_block",
    name = "Grid Entry",
    description = paste0(
      "Multi-row data entry as an editable grid (Tabulator). Upstream ",
      "tibble defines the schema; the grid's rows replace the upstream ",
      "row set. Paste-from-Excel as the primary entry path."
    ),
    category = "transform",
    package = "blockr.input"
  )
  register_blocks(
    "new_table_block",
    name = "Table CRUD",
    description = paste0(
      "Server-paginated browse-and-edit over a tibble or dbplyr lazy ",
      "table. Sort, search, page; pending edits visible above the page; ",
      "composes dplyr::rows_upsert and dplyr::rows_delete on Apply."
    ),
    category = "transform",
    package = "blockr.input"
  )
}
