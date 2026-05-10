# Table-block dev: blank-entry mode.
#
# Upstream is a 0-row tibble that declares the schema. Use "+ Add row"
# (auto-fills the key) or paste a TSV from Excel into the strip area.
#
# From /workspace:
#   Rscript blockr.input/dev/table-blank.R
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
    table  = new_table_block(),
    head   = new_head_block(n = 100L)
  ),
  links = links(
    from = c("schema", "table"),
    to   = c("table",  "head")
  ),
  extensions = list(
    blockr.dag::new_dag_extension()
  )
)

shiny::runApp(serve(board))
