# Grid-block dev: bulk-edit mode over a small upstream tibble.
#
# Upstream has rows; the grid hydrates with them; user can edit any cell,
# add or delete rows. Output replaces the upstream row set.
#
# From /workspace:
#   Rscript blockr.input/dev/grid-bulk.R
# then open http://127.0.0.1:3838/

pkgload::load_all("blockr.core")
pkgload::load_all("blockr.dplyr")
pkgload::load_all("blockr.dock")
pkgload::load_all("blockr.dag")
pkgload::load_all("blockr.input")

applicants <- tibble::tibble(
  id         = 1:5,
  name       = c("Alice", "Bob", "Carol", "Dan", "Eve"),
  dob        = as.Date(c("1985-04-12", "1972-11-03", "1990-07-21",
                         "1968-02-29", "1995-12-30")),
  risk_class = factor(
    c("preferred", "standard", "substandard", "standard", "preferred"),
    levels = c("preferred", "standard", "substandard")
  )
)

board <- new_dock_board(
  blocks = c(
    data = new_static_block(data = applicants),
    grid = new_grid_block()
  ),
  links = links(
    from = "data",
    to   = "grid"
  ),
  extensions = list(
    blockr.dag::new_dag_extension()
  )
)

shiny::runApp(serve(board))
