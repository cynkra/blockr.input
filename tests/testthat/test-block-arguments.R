# Guard the AI-facing `*_arguments()` descriptors against drift from the block
# constructors. A descriptor may advertise a SUBSET of the constructor formals
# (the runtime-only `upserts` / `deletes` accumulators are deliberately hidden),
# but it must never advertise a phantom argument, and its `examples` must only
# carry keys the descriptor itself defines.

ctor_formals <- function(ctor) {
  setdiff(names(formals(ctor)), "...")
}

test_that("every *_arguments() descriptor is consistent with its constructor", {
  pairs <- list(
    list(args = edit_arguments,       ctor = new_edit_block),
    list(args = grid_arguments,       ctor = new_grid_entry_block),
    list(args = table_crud_arguments, ctor = new_table_crud_block)
  )

  for (p in pairs) {
    args <- p$args()
    ctor <- ctor_formals(p$ctor)
    ex   <- attr(args, "examples")

    # no phantom arguments advertised to the assistant
    expect_true(all(names(args) %in% ctor))
    # examples never reference a key the descriptor doesn't define
    expect_true(all(names(ex) %in% names(args)))
    # examples cover exactly the advertised arguments, in the same order
    expect_identical(names(args), names(ex))
    # descriptor entries are non-empty strings
    expect_true(all(nzchar(unlist(args))))
    # each descriptor carries a prompt
    expect_true(nzchar(attr(args, "prompt")))
  }
})

test_that("runtime accumulators are hidden from the assistant surface", {
  expect_false(any(c("upserts", "deletes") %in% names(edit_arguments())))
  expect_false(any(c("upserts", "deletes") %in% names(grid_arguments())))
  expect_false(any(c("upserts", "deletes") %in% names(table_crud_arguments())))
})
