#' HTML dependency for the table block
#'
#' Bundles the JS class + CSS for `new_table_edit_block()`. Hand-rolled,
#' no Tabulator dependency.
#'
#' @return An `htmltools::tagList` of `htmlDependency` objects.
#'
#' @export
table_block_dep <- function() {
  htmltools::tagList(
    htmltools::htmlDependency(
      name = "table-block-js",
      version = utils::packageVersion("blockr.input"),
      src = system.file("js", package = "blockr.input"),
      script = "table-block.js"
    ),
    htmltools::htmlDependency(
      name = "table-block-css",
      version = utils::packageVersion("blockr.input"),
      src = system.file("css", package = "blockr.input"),
      stylesheet = "table-block.css"
    )
  )
}
