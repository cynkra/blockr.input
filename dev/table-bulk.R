# Table-block dev: small in-memory tibble.
#
# Browse + edit a 5-row applicants tibble. Sort by clicking column headers.
# Search via the input above the page. Edits accumulate in the pending strip.
# Apply commits.
#
# From /workspace:
#   Rscript blockr.input/dev/table-bulk.R
# then open http://127.0.0.1:3838/

pkgload::load_all("blockr.core")
pkgload::load_all("blockr.dplyr")
pkgload::load_all("blockr.dock")
pkgload::load_all("blockr.dag")
pkgload::load_all("blockr.input")

applicants <- tibble::tibble(
  id   = 1:5,
  name = c("Alice", "Bob", "Carol", "Dan", "Eve"),
  dob  = as.Date(c("1985-04-12", "1972-11-03", "1990-07-21",
                   "1968-02-29", "1995-12-30")),
  risk_class = factor(
    c("preferred", "standard", "substandard", "standard", "preferred"),
    levels = c("preferred", "standard", "substandard")
  )
)

board <- new_dock_board(
  blocks = c(
    data  = new_static_block(data = applicants),
    table = new_table_block(),
    head  = new_head_block(n = 100L)
  ),
  links = links(
    from = c("data", "table"),
    to   = c("table", "head")
  ),
  extensions = list(
    blockr.dag::new_dag_extension()
  )
)

shiny::runApp(serve(board))
