eval_bquoted <- function(expr, df) {
  resolved <- do.call(bquote, list(expr, list(data = quote(df))))
  eval(resolved, envir = list(df = df))
}

test_that("no key_col → pass-through", {
  upstream <- tibble::tibble(id = 1:3, name = c("a", "b", "c"))
  state <- list(key_col = NULL,
                upserts = list(list(id = 99, name = "x")),
                deletes = list())
  expect_equal(eval_bquoted(make_table_expr(state, upstream), upstream), upstream)
})

test_that("empty upserts and empty deletes → pass-through", {
  upstream <- tibble::tibble(id = 1:3, name = c("a", "b", "c"))
  state <- list(key_col = "id", upserts = list(), deletes = list())
  expect_equal(eval_bquoted(make_table_expr(state), upstream), upstream)
})

test_that("upserts insert new rows", {
  upstream <- tibble::tibble(id = 1:2, name = c("a", "b"))
  state <- list(
    key_col = "id",
    upserts = list(list(id = 3L, name = "c")),
    deletes = list()
  )
  out <- eval_bquoted(make_table_expr(state, upstream), upstream)
  expect_equal(nrow(out), 3L)
  expect_equal(out$name, c("a", "b", "c"))
})

test_that("deletes remove rows by key", {
  upstream <- tibble::tibble(id = 1:3, name = c("a", "b", "c"))
  state <- list(key_col = "id", upserts = list(), deletes = list(2L))
  out <- eval_bquoted(make_table_expr(state, upstream), upstream)
  expect_equal(out$id, c(1L, 3L))
})

test_that("string upserts cast to upstream Date / factor types", {
  upstream <- tibble::tibble(
    id   = 1:2,
    dob  = as.Date(c("1985-04-12", "1972-11-03")),
    risk = factor(c("preferred", "standard"),
                  levels = c("preferred", "standard", "substandard"))
  )
  state <- list(
    key_col = "id",
    upserts = list(list(id = 2L, dob = "1990-01-01", risk = "substandard")),
    deletes = list()
  )
  out <- eval_bquoted(make_table_expr(state, upstream), upstream)
  expect_s3_class(out$dob,  "Date")
  expect_s3_class(out$risk, "factor")
  expect_equal(out$dob[2],  as.Date("1990-01-01"))
  expect_equal(as.character(out$risk[2]), "substandard")
})
