df_fixture <- function(n = 12) {
  tibble::tibble(
    id   = seq_len(n),
    name = paste0("name_", letters[seq_len(n)]),
    age  = rev(seq_len(n) + 20L)
  )
}

test_that("first page returns the first page_size rows", {
  d <- df_fixture(12)
  res <- slice_page(d, list(page = 1L, page_size = 5L))
  expect_equal(nrow(res$rows), 5L)
  expect_equal(res$rows$id, 1:5)
  expect_equal(res$page, 1L)
  expect_equal(res$total_rows, 12L)
  expect_equal(res$max_page, 3L)
})

test_that("second page returns the next slice", {
  d <- df_fixture(12)
  res <- slice_page(d, list(page = 2L, page_size = 5L))
  expect_equal(res$rows$id, 6:10)
  expect_equal(res$page, 2L)
})

test_that("partial last page", {
  d <- df_fixture(12)
  res <- slice_page(d, list(page = 3L, page_size = 5L))
  expect_equal(nrow(res$rows), 2L)
  expect_equal(res$rows$id, 11:12)
})

test_that("clamps to last page when page > max_page", {
  d <- df_fixture(7)
  res <- slice_page(d, list(page = 99L, page_size = 5L))
  expect_equal(res$page, 2L)
})

test_that("sort asc / desc works", {
  d <- df_fixture(5)
  res_asc  <- slice_page(d, list(sort_col = "age", sort_dir = "asc",  page_size = 5L))
  res_desc <- slice_page(d, list(sort_col = "age", sort_dir = "desc", page_size = 5L))
  expect_equal(res_asc$rows$age,  sort(res_asc$rows$age))
  expect_equal(res_desc$rows$age, rev(sort(res_desc$rows$age)))
})

test_that("search filters character columns", {
  d <- df_fixture(12)
  res <- slice_page(d, list(search = "name_a", page_size = 50L))
  expect_equal(res$total_rows, 1L)
  expect_equal(res$rows$name, "name_a")
})

test_that("0-row upstream → max_page = 1", {
  d <- tibble::tibble(id = integer(), name = character())
  res <- slice_page(d, list())
  expect_equal(nrow(res$rows), 0L)
  expect_equal(res$total_rows, 0L)
  expect_equal(res$max_page, 1L)
  expect_equal(colnames(res$rows), c("id", "name"))
})
