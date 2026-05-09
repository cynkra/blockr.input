#' HTML dependency for the edit block
#'
#' Bundles the JS class + CSS for `new_edit_block()`. Exported so other blockr
#' packages can embed the edit-block UI.
#'
#' @return An `htmltools::tagList` of `htmlDependency` objects.
#'
#' @export
edit_block_dep <- function() {
  htmltools::tagList(
    htmltools::htmlDependency(
      name = "edit-block-js",
      version = utils::packageVersion("blockr.input"),
      src = system.file("js", package = "blockr.input"),
      script = "edit-block.js"
    ),
    htmltools::htmlDependency(
      name = "edit-block-css",
      version = utils::packageVersion("blockr.input"),
      src = system.file("css", package = "blockr.input"),
      stylesheet = "edit-block.css"
    )
  )
}
