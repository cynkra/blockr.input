# Edit-block dev: small applicants tibble.
#
# Pick a row from the upstream table, edit fields, hit Apply. "+ Add row"
# inserts a new applicant; "Delete row" removes one. Output flows downstream
# as the modified tibble. Use the cogwheel to change key / display / editable
# columns.
#
# From /workspace:
#   Rscript blockr.input/dev/edit-existing.R
# then open http://127.0.0.1:3838/

pkgload::load_all("blockr.core")
pkgload::load_all("blockr.dplyr")
pkgload::load_all("blockr.dock")
pkgload::load_all("blockr.dag")
pkgload::load_all("blockr.input")

applicants <- tibble::tibble(
  policy_id   = c("P0001", "P0002", "P0003", "P0004", "P0005"),
  full_name   = c("Alice Wong", "Bob Smith", "Carol Diaz", "Dan Lee", "Eve Park"),
  age         = c(34L, 52L, 41L, 28L, 60L),
  smoker      = c("no", "yes", "no", "no", "yes"),
  sum_assured = c(150000, 250000, 100000, 75000, 500000)
)

board <- new_dock_board(
  blocks = c(
    data = new_static_block(data = applicants),
    edit = new_form_edit_block(
      key_col       = "policy_id",
      display_cols  = list("full_name"),
      editable_cols = list("age", "smoker", "sum_assured")
    )
  ),
  links = links(
    from = "data",
    to   = "edit"
  ),
  extensions = list(
    blockr.dag::new_dag_extension()
  )
)

shiny::runApp(serve(board))
