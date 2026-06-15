# AI-facing argument descriptors for the interactive blocks.
#
# Each `*_arguments()` returns a named character vector (one entry per argument
# the assistant may set) carrying a description, plus `examples` and `prompt`
# attributes. blockr.core stores these in the registry; the MCP server and the
# assistant read them to populate and explain block arguments.
#
# Only CREATION-TIME configuration is advertised. The `upserts` / `deletes`
# constructor arguments are runtime accumulators for pending edits the end user
# makes in the widget — never something the assistant authors — so they are
# deliberately omitted from the surface (a subset of the formals, like the
# runtime-transport fields hidden in blockr.viz).

#' @noRd
edit_arguments <- function() {
  structure(
    c(
      key_col = paste0(
        "Name of the upstream column that uniquely identifies a row — the ",
        "key that dplyr::rows_upsert() / rows_delete() match on. Required ",
        "before any edit applies. Names a data column, never a literal."
      ),
      display_cols = paste0(
        "Optional extra columns shown alongside the key in the row-picker ",
        "label, to help the user find the right row. Array of column names; ",
        "default none."
      ),
      editable_cols = paste0(
        "Columns the user may edit, or fill in when adding a new row. Array ",
        "of column names; empty (default) means all non-key columns."
      )
    ),
    examples = list(
      key_col = "id",
      display_cols = list("name"),
      editable_cols = list("age", "status")
    ),
    prompt = paste(
      "Row-level editor: the end user picks one row by `key_col`, then edits,",
      "adds, or deletes it. Set `key_col` to a column whose values are unique",
      "(an id). Use `display_cols` to surface human-readable columns in the",
      "picker, and `editable_cols` to restrict which fields are editable."
    )
  )
}

#' @noRd
grid_arguments <- function() {
  structure(
    c(
      key_col = paste0(
        "Name of the upstream column that uniquely identifies a row — the ",
        "key that dplyr::rows_upsert() / rows_delete() match on. If omitted, ",
        "the block auto-picks the first all-unique column on first load. ",
        "Names a data column, never a literal."
      )
    ),
    examples = list(
      key_col = "id"
    ),
    prompt = paste(
      "Spreadsheet-style bulk entry: the upstream tibble is rendered as an",
      "editable grid and the user pastes / types / deletes rows. Set `key_col`",
      "to the unique-id column so edits compose against upstream by that key;",
      "leave it unset to auto-pick. Loads all rows into the browser — use the",
      "Table CRUD block for large or remote (dbplyr) tables."
    )
  )
}

#' @noRd
table_crud_arguments <- function() {
  structure(
    c(
      key_col = paste0(
        "Name of the upstream column that uniquely identifies a row — the ",
        "key that dplyr::rows_upsert() / rows_delete() match on. If omitted, ",
        "the block auto-picks one on first load. Names a data column, never a ",
        "literal."
      )
    ),
    examples = list(
      key_col = "id"
    ),
    prompt = paste(
      "Server-paginated browse-and-edit: sort, search and page through a",
      "tibble or dbplyr lazy table one page at a time, accumulating pending",
      "edits that apply on Apply. Set `key_col` to the unique-id column;",
      "leave unset to auto-pick. Prefer this over Grid Entry for large or",
      "remote tables (only the current page round-trips to the browser)."
    )
  )
}
