#' HTML dependency for the grid block
#'
#' Bundles the JS class + CSS for `new_grid_edit_block()`, plus the vendored
#' Tabulator dependency. Exported so other blockr packages can embed the
#' grid-block UI.
#'
#' @return An `htmltools::tagList` of `htmlDependency` objects.
#'
#' @export
grid_block_dep <- function() {
  htmltools::tagList(
    tabulator_dep(),
    htmltools::htmlDependency(
      name = "grid-block-js",
      version = utils::packageVersion("blockr.input"),
      src = system.file("js", package = "blockr.input"),
      script = "grid-block.js"
    ),
    htmltools::htmlDependency(
      name = "grid-block-css",
      version = utils::packageVersion("blockr.input"),
      src = system.file("css", package = "blockr.input"),
      stylesheet = "grid-block.css"
    )
  )
}

#' Vendored Tabulator htmlDependency
#'
#' Reads the pinned version from `inst/js/vendor/tabulator/VERSION` so cache
#' busting tracks the JS version, not the package version. No CDN reference.
#'
#' @noRd
tabulator_dep <- function() {
  src <- system.file("js", "vendor", "tabulator", package = "blockr.input")
  version_file <- file.path(src, "VERSION")
  version <- if (file.exists(version_file)) {
    trimws(readLines(version_file, warn = FALSE)[[1L]])
  } else {
    "0.0.0"
  }
  htmltools::htmlDependency(
    name       = "tabulator",
    version    = version,
    src        = src,
    script     = "tabulator.min.js",
    stylesheet = "tabulator.min.css"
  )
}
