eval_bquoted <- function(expr, df) {
  resolved <- do.call(bquote, list(expr, list(data = quote(df))))
  eval(resolved, envir = list(df = df))
}

test_that("no key_col → pass-through", {
  upstream <- tibble::tibble(id = 1:3, name = c("a", "b", "c"))
  state <- list(key_col = NULL,
                upserts = list(list(id = 99, name = "x")),
                deletes = list())
  expr <- make_grid_expr(state)
  out  <- eval_bquoted(expr, upstream)
  expect_equal(out, upstream)
})

test_that("empty upserts + empty deletes → pass-through", {
  upstream <- tibble::tibble(id = 1:3, name = c("a", "b", "c"))
  state <- list(key_col = "id", upserts = list(), deletes = list())
  expect_equal(eval_bquoted(make_grid_expr(state), upstream), upstream)
})

test_that("upserts only inserts new rows", {
  upstream <- tibble::tibble(id = 1:2, name = c("a", "b"))
  state <- list(
    key_col = "id",
    upserts = list(list(id = 3L, name = "c")),
    deletes = list()
  )
  out <- eval_bquoted(make_grid_expr(state), upstream)
  expect_equal(nrow(out), 3L)
  expect_equal(out$id, c(1L, 2L, 3L))
  expect_equal(out$name, c("a", "b", "c"))
})

test_that("upserts updates existing rows in place", {
  upstream <- tibble::tibble(id = 1:3, name = c("a", "b", "c"))
  state <- list(
    key_col = "id",
    upserts = list(list(id = 2L, name = "BOB")),
    deletes = list()
  )
  out <- eval_bquoted(make_grid_expr(state), upstream)
  expect_equal(out$name, c("a", "BOB", "c"))
})

test_that("deletes removes rows by key", {
  upstream <- tibble::tibble(id = 1:3, name = c("a", "b", "c"))
  state <- list(
    key_col = "id",
    upserts = list(),
    deletes = list(2L)
  )
  out <- eval_bquoted(make_grid_expr(state), upstream)
  expect_equal(out$id, c(1L, 3L))
})

test_that("deletes + upserts compose in order (delete first)", {
  upstream <- tibble::tibble(id = 1:3, name = c("a", "b", "c"))
  state <- list(
    key_col = "id",
    upserts = list(list(id = 2L, name = "REINSERT")),
    deletes = list(2L)
  )
  # Delete 2, then re-insert 2 with new name → id=2 ends up as REINSERT.
  out <- eval_bquoted(make_grid_expr(state), upstream)
  expect_equal(nrow(out), 3L)
  row2 <- out[out$id == 2L, ]
  expect_equal(row2$name, "REINSERT")
})

test_that("0-row upstream + upserts → just the upserts", {
  upstream <- tibble::tibble(id = integer(), name = character())
  state <- list(
    key_col = "id",
    upserts = list(
      list(id = 1L, name = "Alice"),
      list(id = 2L, name = "Bob")
    ),
    deletes = list()
  )
  out <- eval_bquoted(make_grid_expr(state, upstream), upstream)
  expect_equal(nrow(out), 2L)
  expect_equal(out$id, c(1L, 2L))
})

test_that("string upserts cast to upstream Date / factor types", {
  upstream <- tibble::tibble(
    id   = 1:2,
    dob  = as.Date(c("1985-04-12", "1972-11-03")),
    risk = factor(c("preferred", "standard"),
                  levels = c("preferred", "standard", "substandard"))
  )
  # JS sends strings — make_grid_expr must cast back so rows_upsert works.
  state <- list(
    key_col = "id",
    upserts = list(list(id = 2L, dob = "1990-01-01", risk = "substandard")),
    deletes = list()
  )
  out <- eval_bquoted(make_grid_expr(state, upstream), upstream)
  expect_s3_class(out$dob,  "Date")
  expect_s3_class(out$risk, "factor")
  expect_equal(out$dob[2],  as.Date("1990-01-01"))
  expect_equal(as.character(out$risk[2]), "substandard")
})

test_that("deletes cast key value to upstream type (Date key)", {
  upstream <- tibble::tibble(
    when = as.Date(c("2026-01-01", "2026-02-01", "2026-03-01")),
    val  = 1:3
  )
  state <- list(
    key_col = "when",
    upserts = list(),
    deletes = list("2026-02-01")
  )
  out <- eval_bquoted(make_grid_expr(state, upstream), upstream)
  expect_equal(nrow(out), 2L)
  expect_equal(out$when, as.Date(c("2026-01-01", "2026-03-01")))
})
