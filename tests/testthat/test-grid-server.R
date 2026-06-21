## Tier 2 (testServer round-trip) is deferred for v1. The block_server
## generic in blockr.core wraps the inner module in ways that need a
## fixture beyond `shiny::testServer`. Tier 1 (`test-make-grid-expr.R`)
## covers the critical logic; manual smoke-testing in
## `inst/examples/grid-blank.R` covers the round-trip for now.

test_that("grid block constructor returns the expected class", {
  blk <- new_grid_entry_block()
  expect_s3_class(blk, "grid_entry_block")
  expect_s3_class(blk, "transform_block")
  expect_s3_class(blk, "block")
})
