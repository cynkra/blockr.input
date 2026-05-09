eval_bquoted <- function(expr_obj, data) {
  eval(expr_obj, envir = list(data = data), enclos = baseenv())
}

test_that("empty rows + non-empty upstream → 0-row tibble preserving columns", {
  upstream <- tibble::tibble(id = 1:3, name = c("a", "b", "c"))
  expr <- make_grid_expr(list(rows = list()), upstream)
  out <- eval_bquoted(expr, upstream)
  expect_s3_class(out, "tbl_df")
  expect_equal(nrow(out), 0L)
  expect_equal(colnames(out), c("id", "name"))
})

test_that("empty rows + 0-row upstream → 0-row tibble with same columns", {
  upstream <- tibble::tibble(id = integer(), name = character())
  expr <- make_grid_expr(list(rows = list()), upstream)
  out <- eval_bquoted(expr, upstream)
  expect_equal(nrow(out), 0L)
  expect_equal(colnames(out), c("id", "name"))
})

test_that("non-empty rows produce a typed tibble", {
  upstream <- tibble::tibble(
    id   = integer(),
    name = character(),
    dob  = as.Date(character())
  )
  state <- list(rows = list(
    list(id = "1", name = "Alice", dob = "1985-04-12"),
    list(id = "2", name = "Bob",   dob = "1972-11-03")
  ))
  expr <- make_grid_expr(state, upstream)
  out  <- eval_bquoted(expr, upstream)
  expect_equal(nrow(out), 2L)
  expect_equal(out$id, c(1L, 2L))
  expect_equal(out$name, c("Alice", "Bob"))
  expect_equal(out$dob, as.Date(c("1985-04-12", "1972-11-03")))
})

test_that("factor column preserves levels", {
  upstream <- tibble::tibble(
    risk = factor(character(),
                  levels = c("preferred", "standard", "substandard"))
  )
  state <- list(rows = list(
    list(risk = "preferred"),
    list(risk = "standard")
  ))
  out <- eval_bquoted(make_grid_expr(state, upstream), upstream)
  expect_s3_class(out$risk, "factor")
  expect_equal(levels(out$risk),
               c("preferred", "standard", "substandard"))
  expect_equal(as.character(out$risk), c("preferred", "standard"))
})

test_that("NA-tolerant integer cells", {
  upstream <- tibble::tibble(id = integer(), name = character())
  state <- list(rows = list(
    list(id = "",    name = "Alice"),
    list(id = "42",  name = "Bob")
  ))
  out <- eval_bquoted(make_grid_expr(state, upstream), upstream)
  expect_equal(out$id, c(NA_integer_, 42L))
  expect_equal(out$name, c("Alice", "Bob"))
})

test_that("returns a language object (bbquoted)", {
  upstream <- tibble::tibble(id = integer())
  expr <- make_grid_expr(list(rows = list()), upstream)
  expect_true(is.language(expr) ||
              inherits(expr, "blockr_expr") ||
              is.list(expr))
})
