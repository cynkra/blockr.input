# Grid-block dev: blank-entry mode.
#
# Upstream is a 0-row tibble that declares the schema. Grid opens with one
# blank row; user types or pastes a TSV from Excel; downstream sees the
# emitted tibble.
#
# From /workspace:
#   Rscript blockr.input/dev/grid-blank.R
# then open http://127.0.0.1:3838/

pkgload::load_all("blockr.core")
pkgload::load_all("blockr.dplyr")
pkgload::load_all("blockr.dock")
pkgload::load_all("blockr.dag")
pkgload::load_all("blockr.input")

schema <- tibble::tibble(
  id         = integer(),
  name       = character(),
  dob        = as.Date(character()),
  risk_class = factor(
    character(),
    levels = c("preferred", "standard", "substandard")
  )
)

board <- new_dock_board(
  blocks = c(
    schema = new_static_block(data = schema),
    grid   = new_grid_block(),
    head   = new_head_block(n = 100L)
  ),
  links = links(
    from = c("schema", "grid"),
    to   = c("grid",   "head")
  ),
  extensions = list(
    blockr.dag::new_dag_extension()
  )
)

shiny::runApp(serve(board))
