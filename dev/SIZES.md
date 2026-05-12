# Three sizes: S, M, XL

`blockr.input` ships three CRUD blocks. They are not competitors; each one
fits a row-count regime where the other two are awkward.

| Size | Block            | Row regime           | UI shape                          |
|------|------------------|----------------------|-----------------------------------|
| S    | `new_edit_block` | up to ~3 rows        | row picker + transposed form      |
| M    | `new_grid_block` | tens to low thousands| Tabulator grid, paste from Excel  |
| XL   | `new_table_block`| tens of thousands +  | server-paginated page + strip     |

## Why three

- **S** wins when the user is supposed to look at *this row* and fill in
  fields. A grid for one row hides the meaning of each column. A form with
  clear labels is the right surface.
- **M** wins for the typical underwriting / claims worksheet: dozens to a
  few hundred rows, paste-from-Excel is the dominant entry path, full
  visibility of every row matters. Confirmed by `blockr.insurance/dev/life-underwriting-ws3.R`.
- **XL** wins as soon as the table is too big to ship to the browser, or
  lives in a database (dbplyr lazy table). Loading 100k rows into Tabulator
  is wasteful; loading 10M rows is impossible.

## Common principles (the three are one family)

These are invariants the three blocks already share, and that any future
work should preserve.

1. **Transform block, bquoted expr.** All three use
   `blockr.core::new_transform_block()` with `expr_type = "bquoted"` and
   `external_ctrl = TRUE`. State round-trips through the standard blockr
   reactives.
2. **Schema flows from upstream.** No manual column declaration. Connect a
   tibble (or a 0-row tibble for blank entry) and the block reads the
   column set off it.
3. **One key column.** A single `key_col` identifies a row across upserts
   and deletes. Auto-picked when possible (first all-unique column);
   override via cogwheel.
4. **State shape.** `key_col`, `upserts` (list of named lists), `deletes`
   (list of key values). Edit adds `display_cols` and `editable_cols`.
5. **Output expr.** All three emit
   `data |> dplyr::rows_delete(...) |> dplyr::rows_upsert(...)` against
   the upstream. Downstream blocks see a normal tibble (or lazy table).
6. **Blank-entry mode.** Plug a 0-row upstream and the block becomes
   insert-only. Same UI, no special block needed.
7. **Apply commits.** Edits buffer locally; an explicit Apply pushes the
   diff to R. After first Apply, subsequent edits stream automatically
   (consistent across S/M; XL keeps a strip).

## Per-size detail and what's missing

### S — `new_edit_block`

Row picker + form. Today the form is vertical fields (one per editable
col). The label is the column name. Good for 1 to ~3 rows but not yet
specialised enough to *replace* a grid for n=1.

Gaps:
- No richer column labels. Today the field label is the bare column name.
  Should read `attr(col, "label")` off the upstream tibble (the standard
  `labelled` / `haven` convention) so labels travel with the data, not
  with a block-specific config object.
- nrow=1 case still needs the user to pick the row from a one-item
  dropdown. Should auto-select when upstream has exactly one row.
- nrow=0 (blank insert) works but the "+ Add row" affordance is the same
  small button as in the multi-row case. For nrow ≤ 3 the form should be
  the surface and "add row" should be tertiary.
- No way to express groups / sections of fields.

### M — `new_grid_block`

Tabulator-backed editable grid. Excel paste works, looks good, validates
per-cell. Pending edits highlight inline by row class. An Apply button
commits the diff. **No "staging strip" — pending state lives inline on
the grid rows themselves.**

Cell commit is already a deliberate gesture: Tabulator's `cellEdited`
fires on Enter or blur, not on keystroke (`grid-block.js:296`). That
makes the Apply button redundant for the common path. Drop it; commit on
cell-edit.

Gaps:
- Only in-memory. Connecting a dbplyr lazy table doesn't make sense here
  and isn't blocked. Should error when upstream is lazy, pointing at
  Table CRUD.
- No row-count budget. A user can connect 100k rows and the browser will
  suffer in silence. Needs a soft warning above some threshold (start
  at 5k) pointing at Table CRUD.
- Apply button is redundant given cell-commit-on-Enter; remove.
- No column labels (same `attr(col, "label")` gap as S).

### XL — `new_table_block`

Server-paginated. Sort, search, page handled in R; only the current page
slice ships to the browser. Works on tibbles and on dbplyr lazy tables.
Pending edits are highlighted inline on the page (when the row is in the
visible slice); a "N pending" badge next to the search input surfaces
*all* pending edits and toggles a pending-only filter mode. No strip,
no Apply button (autocommit, same gesture as M).

Gaps:
- Search is a single global `LIKE %x%` on text columns. No per-column
  filter, no numeric range, no date range.
- Sort/search performance on lazy tables depends on indexes; no escape
  hatch to push specific predicates through.
- No way to mark a row as "in review" / partial state.
- Pending-only mode disables pagination (renders all pending rows in
  one go). Fine for typical pending sets but degrades if someone
  pastes thousands of rows.
- Off-page pending updates: the inline diff class on the row is only
  applied when the row is in the visible slice. The badge tells the
  user "stuff is pending elsewhere" but the page itself can't show
  which other rows are affected until they toggle pending-only.

## Open question: can M and XL fuse?

The XL strip is gone. Pending state lives inline on the row when the
row is in the visible slice; otherwise the "N pending" badge surfaces
the count and toggles a pending-only filter that loads exactly those
rows on demand. Position-on-page is not claimed for off-page edits
(badge is in a fixed slot, not "above" or "below").

What's left to differ between M and XL:

- **Rendering tool**: Tabulator (M, fully JS) vs. our own hand-rolled
  HTML table (XL, server-paginated). Choice driven by data size and
  by whether the source is lazy.
- **Pagination**: M loads everything; XL pages in slices. With M now
  hard-erroring on lazy tables and warning above 5k rows, the
  boundary is sharp.

These are real architectural differences, not just UX. Fusing them
would mean either "Tabulator over a virtual scroll backed by R" or
"server-pagination as a Tabulator data adapter" — both are work.

Not worth fusing yet. Two blocks with shared semantics is the right
shape. Revisit if the rendering parity drifts further.

## TODO

Ordered by what unlocks the most.

1. **Read column attributes off the tibble.** No new config object. All
   three blocks consume the same df interface; richer labels come from
   `attr(col, "label")` (the `labelled` / `haven` convention) so they
   travel with the data through the pipeline. If a column has no label
   attr, fall back to the column name. Same rule for any future hints
   (units, description): live on the column, not in block state.
2. **S: real transposed form, multi-row.** When upstream has more than
   one row, show them side-by-side (or stacked): one column per upstream
   row, one row per editable field, label on the left. Drop the
   row-picker dropdown for the small-n case. nrow=1 collapses to a
   single column. Cap at ~3 rows; above that the user wants M.
3. **M: drop the Apply button.** Tabulator's `cellEdited` already
   commits on Enter/blur — the per-cell gesture is the commit. Send
   the diff on each `cellEdited` / `rowAdded` / `rowDeleted` /
   `clipboardPasted`. No staging UI on M.
4. **M: lazy-table error + row-budget warning** (agreed, do it).
   - `inherits(upstream, "tbl_lazy")` → error pointing at Table CRUD.
   - `nrow(upstream) > 5000` → soft banner above the grid pointing at
     Table CRUD. Threshold tunable via `getOption("blockr.input.grid_max_rows")`.
5. ~~**XL: staging without the strip.**~~ Done.
   - On-page pending: inline diff class on the row.
   - Off-page pending: "N pending" badge in a fixed slot next to the
     search input. Click toggles a pending-only filter mode that loads
     only the affected upstream rows + null-keyed inserts. No
     position is claimed for off-page edits.
   - Apply button gone (autocommit, same as M).
   - +Add row auto-switches into pending-only so the new row is
     immediately visible.
6. **XL: per-column filter.** At minimum a numeric range and an exact-
   match text filter alongside the global search.
7. **Registry: advertise the size tier.** Block descriptions should say
   "for small / medium / large tables" so dashboard builders pick
   correctly without reading source.
8. **Shared internals audit.** `build_column_meta`, expression builders,
   state normalisation are partially shared. Consolidate so a fix in
   one place lands in all three.
9. **Revisit M/XL fusion** after 5 lands.

## Files

- `R/edit_block.R`, `inst/js/edit-block.js`, `inst/css/edit-block.css`
- `R/grid_block.R`, `inst/js/grid-block.js`, `inst/css/grid-block.css`
- `R/table_block.R`, `inst/js/table-block.js`, `inst/css/table-block.css`
- Dev scripts: `dev/edit-existing.R`, `dev/grid-bulk.R`, `dev/grid-blank.R`,
  `dev/table-bulk.R`, `dev/table-blank.R`, `dev/table-large.R`,
  `dev/table-dbplyr.R`
- Reference prototype: `blockr.insurance/dev/life-underwriting-ws3.R`
