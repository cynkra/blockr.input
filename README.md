# blockr.input

Interactive data-entry blocks for blockr.

blockr.input extends [blockr.core](https://github.com/BristolMyersSquibb/blockr.core)
with blocks that let an end user *edit* data inside a running dashboard — pick a
row and change its values, type or paste a grid of new rows, or browse and edit
a large table page by page. Each block emits ordinary `dplyr` row operations
(`rows_upsert()` / `rows_delete()`), so an edit is just another reproducible
step in the workflow — the user never writes R.

## Installation

```r
# install.packages("pak")
pak::pak("cynkra/blockr.input")
```

## Blocks

| Block | What it does |
|---|---|
| `new_form_edit_block()` | Pick a row from the upstream table by a key column, edit its values, add new rows, or delete rows. Composes `dplyr::rows_upsert()` and `dplyr::rows_delete()`. |
| `new_grid_edit_block()` | Multi-row data entry as an editable grid (Tabulator). The upstream tibble defines the schema; the grid's rows replace the upstream row set. Paste-from-Excel is the primary entry path. |
| `new_table_edit_block()` | Server-paginated browse-and-edit over a tibble or a `dbplyr` lazy table. Sort, search, page; pending edits are shown above the current page and applied with `rows_upsert()` / `rows_delete()` on Apply. |

The blocks register themselves with the block-adder (and the assistant block
universe) when the package is loaded — no manual registration call is needed.

## Demo

A static table feeds a form editor; edit a row and the change flows downstream.

```r
library(blockr.core)
library(blockr.dock)
library(blockr.input)

board <- new_dock_board(
  blocks = c(
    data = new_static_block(
      data.frame(
        id   = 1:3,
        name = c("Ada", "Bob", "Cleo"),
        score = c(90, 75, 88)
      )
    ),
    edit = new_form_edit_block(key_col = "id")
  ),
  links = links(from = "data", to = "edit")
)

serve(board)
```

See the example scripts in `dev/` for the grid and table editors and for
dbplyr-backed editing.
