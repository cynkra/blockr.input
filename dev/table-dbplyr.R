# Table-block dev: dbplyr lazy table backed by SQLite.
#
# Verify that the table block works against a remote database
# without collecting the full upstream. Sort, search, page push down
# to SQL.
#
# From /workspace:
#   Rscript blockr.input/dev/table-dbplyr.R
# then open http://127.0.0.1:3838/

pkgload::load_all("blockr.core")
pkgload::load_all("blockr.dplyr")
pkgload::load_all("blockr.dock")
pkgload::load_all("blockr.dag")
pkgload::load_all("blockr.input")

set.seed(2)
n <- 1000L
applicants <- tibble::tibble(
  id   = seq_len(n),
  name = paste0("name_", sprintf("%04d", seq_len(n))),
  age  = sample(18:90, n, replace = TRUE),
  tier = sample(c("a", "b", "c"), n, replace = TRUE)
)

con <- DBI::dbConnect(RSQLite::SQLite(), ":memory:")
DBI::dbWriteTable(con, "applicants", applicants)
lazy <- dplyr::tbl(con, "applicants")

board <- new_dock_board(
  blocks = c(
    data  = new_static_block(data = lazy),
    table = new_table_crud_block(),
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
