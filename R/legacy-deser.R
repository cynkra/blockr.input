#' Legacy deserialization for old block formats
#'
#' Restores boards saved before the interactive blocks were flattened. Each
#' block used to take a single opaque `state = list(...)` constructor argument
#' and serialize it under one `state` payload key; they now take flat top-level
#' arguments (`key_col`, `upserts`, ...) serialized as flat sibling payload
#' entries.
#'
#' This deserializer unwraps the interim single-`state` blob back to flat
#' constructor arguments; current (flat) payloads pass straight through. Block
#' attributes (`block_name`, ...) ride along as siblings of `state`, so lifting
#' only the `state` key preserves them. The original serialized class is
#' restored so blockr.core's post-deser class check passes even when the block
#' was since renamed (e.g. `table_block` -> `table_crud_block`).
#'
#' Drop this file when backwards compatibility is no longer needed.
#'
#' @name legacy-deser
#' @keywords internal
NULL

# Unwrap an old single-`state` payload to flat constructor args and rebuild.
legacy_deser_input_block <- function(data) {
  stopifnot(all(c("constructor", "payload") %in% names(data)))

  payload <- data[["payload"]]
  if ("state" %in% names(payload)) {
    # Interim single-blob format: lift the state fields up next to the block
    # attributes (which are stored as siblings of `state`).
    extras <- payload[setdiff(names(payload), "state")]
    payload <- c(payload[["state"]], extras)
  }

  ctor <- blockr.core::blockr_deser(data[["constructor"]])
  args <- c(
    payload,
    list(
      ctor = blockr.core::coal(
        blockr.core::ctor_name(ctor),
        blockr.core::ctor_fun(ctor)
      ),
      ctor_pkg = blockr.core::ctor_pkg(ctor)
    )
  )
  res <- do.call(blockr.core::ctor_fun(ctor), args)

  # Restore the original serialized class so blockr.core's class check passes
  # (handles the table_block -> table_crud_block rename).
  orig <- data[["object"]]
  if (!is.null(orig) && !identical(class(res), orig)) {
    class(res) <- orig
  }
  res
}

#' @rdname legacy-deser
#' @param x,data,... Passed through from [blockr.core::blockr_deser()].
#' @importFrom blockr.core blockr_deser
#' @export
blockr_deser.edit_block <- function(x, data, ...) {
  legacy_deser_input_block(data)
}

#' @rdname legacy-deser
#' @export
blockr_deser.grid_entry_block <- function(x, data, ...) {
  legacy_deser_input_block(data)
}

#' @rdname legacy-deser
#' @export
blockr_deser.table_crud_block <- function(x, data, ...) {
  legacy_deser_input_block(data)
}
