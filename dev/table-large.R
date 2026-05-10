# Table-block dev: 100k-row in-memory tibble.
#
# Stress-test the server-paginated browse. Page-size selector controls
# how many rows the JS holds at a time. Sort and search are server-side.
#
# From /workspace:
#   Rscript blockr.input/dev/table-large.R
# then open http://127.0.0.1:3838/

pkgload::load_all("blockr.core")
pkgload::load_all("blockr.dplyr")
pkgload::load_all("blockr.dock")
pkgload::load_all("blockr.dag")
pkgload::load_all("blockr.input")

set.seed(1)
n <- 100000L
big <- tibble::tibble(
  id    = seq_len(n),
  name  = paste0("name_", sprintf("%06d", sample(seq_len(n), n))),
  age   = sample(18:90, n, replace = TRUE),
  score = round(runif(n, 0, 1000), 2),
  tier  = factor(
    sample(c("a", "b", "c", "d"), n, replace = TRUE),
    levels = c("a", "b", "c", "d")
  )
)

board <- new_dock_board(
  blocks = c(
    data  = new_static_block(data = big),
    table = new_table_block(),
    head  = new_head_block(n = 5L)
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
