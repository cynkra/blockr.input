eval_bquoted <- function(expr, df) {
  resolved <- do.call(bquote, list(expr, list(data = quote(df))))
  eval(resolved, envir = list(df = df))
}

df_fixture <- function() {
  tibble::tibble(
    id  = c("a", "b", "c"),
    val = c(10L, 20L, 30L),
    grp = c("x", "y", "x")
  )
}

test_that("empty state passes through unchanged", {
  expr <- make_edit_expr(list())
  expect_identical(eval_bquoted(expr, df_fixture()), df_fixture())
})

test_that("missing key_col passes through even with pending ops", {
  expr <- make_edit_expr(list(upserts = list(list(id = "z", val = 99L))))
  expect_identical(eval_bquoted(expr, df_fixture()), df_fixture())
})

test_that("empty key_col string passes through", {
  expr <- make_edit_expr(list(key_col = "", deletes = list("a")))
  expect_identical(eval_bquoted(expr, df_fixture()), df_fixture())
})

test_that("deletes-only removes matching rows", {
  expr <- make_edit_expr(list(
    key_col = "id",
    deletes = list("a", "c")
  ))
  out <- eval_bquoted(expr, df_fixture())
  expect_equal(out$id, "b")
  expect_equal(nrow(out), 1L)
})

test_that("upserts: existing key updates editable cols", {
  expr <- make_edit_expr(list(
    key_col = "id",
    upserts = list(list(id = "a", val = 999L, grp = "x"))
  ))
  out <- eval_bquoted(expr, df_fixture())
  expect_equal(nrow(out), 3L)
  expect_equal(out$val[out$id == "a"], 999L)
  expect_equal(out$val[out$id == "b"], 20L)
})

test_that("upserts: new key appends a row", {
  expr <- make_edit_expr(list(
    key_col = "id",
    upserts = list(list(id = "d", val = 40L, grp = "y"))
  ))
  out <- eval_bquoted(expr, df_fixture())
  expect_equal(nrow(out), 4L)
  expect_equal(out$id[4], "d")
  expect_equal(out$val[4], 40L)
})

test_that("upserts: partial column patch leaves untouched cols intact", {
  # only val is in the patch; grp should stay as upstream
  expr <- make_edit_expr(list(
    key_col = "id",
    upserts = list(list(id = "a", val = 999L))
  ))
  out <- eval_bquoted(expr, df_fixture())
  expect_equal(out$grp[out$id == "a"], "x")
  expect_equal(out$val[out$id == "a"], 999L)
})

test_that("delete + upsert with the same key: re-inserts as fresh row", {
  # delete first, then upsert should insert (key no longer exists post-delete)
  expr <- make_edit_expr(list(
    key_col = "id",
    deletes = list("a"),
    upserts = list(list(id = "a", val = 555L, grp = "z"))
  ))
  out <- eval_bquoted(expr, df_fixture())
  expect_equal(nrow(out), 3L)
  expect_equal(out$val[out$id == "a"], 555L)
  expect_equal(out$grp[out$id == "a"], "z")
})

test_that("multiple deletes + multiple upserts compose correctly", {
  expr <- make_edit_expr(list(
    key_col = "id",
    deletes = list("a", "b"),
    upserts = list(
      list(id = "c", val = 333L, grp = "x"),
      list(id = "d", val = 44L,  grp = "y")
    )
  ))
  out <- eval_bquoted(expr, df_fixture())
  expect_equal(sort(out$id), c("c", "d"))
  expect_equal(out$val[out$id == "c"], 333L)
  expect_equal(out$val[out$id == "d"], 44L)
})

test_that("returns a bbquoted language object", {
  expr <- make_edit_expr(list(
    key_col = "id",
    deletes = list("a")
  ))
  expect_true(is.call(expr) || is.expression(expr) || is.language(expr))
})
