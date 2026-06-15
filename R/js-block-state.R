#' Per-field reactive state for a JS-driven block
#'
#' The interactive blocks in this package are backed by a JS widget that emits
#' the whole block state as a single blob on one Shiny input. This helper
#' decomposes that blob into **one `reactiveVal` per field** (JS -> R) and
#' recombines them to push back to JS (R -> JS), guarded against the resulting
#' echo.
#'
#' Per-field reactiveVals are what make the flat constructor arguments
#' externally controllable: blockr.core resolves `external_ctrl_vars()` to
#' `block_ctor_inputs()` (the flat formals) and requires every one of them to
#' be a `reactiveVal`. They also keep a single source of truth for the
#' constructor-formals / returned-state / serialized-field identity.
#'
#' @param input,session The module server's `input` and `session`.
#' @param name Message prefix; the R -> JS update is sent as
#'   `"<name>-block-update"`.
#' @param input_name Id of the container `<div>` / input the JS widget writes
#'   to (e.g. `"edit_input"`).
#' @param state Named list of initial field values. `names(state)` are the
#'   block's flat fields and must equal the constructor formals.
#' @param normalize_state Function applied to the recombined state before it is
#'   pushed to JS.
#' @param ignore_init Passed to the R -> JS [shiny::observeEvent()]; `TRUE`
#'   suppresses the initial push for blocks that hydrate the widget another way.
#'
#' @return A list with `fields` (named list of per-field `reactiveVal`s, to be
#'   returned as the block's `state`) and `state` (a `reactive` recombining
#'   them, for `expr` and the JS push).
#' @keywords internal
#' @noRd
js_block_state <- function(input, session, name, input_name, state,
                           normalize_state = identity, ignore_init = FALSE) {
  fields <- names(state)

  r_fields <- stats::setNames(
    lapply(fields, function(f) shiny::reactiveVal(state[[f]])),
    fields
  )
  r_state <- shiny::reactive(
    stats::setNames(lapply(fields, function(f) r_fields[[f]]()), fields)
  )

  # Gate to avoid the circular JS -> R -> JS update.
  self_write <- new.env(parent = emptyenv())
  self_write$active <- FALSE

  # JS -> R: fan the single blob out into the per-field reactiveVals.
  shiny::observeEvent(input[[input_name]], {
    self_write$active <- TRUE
    blob <- input[[input_name]]
    for (f in fields) r_fields[[f]](blob[[f]])
  })

  # R -> JS: push the recombined blob whenever any field changes (restore or
  # external control). The per-field writes above land in one flush, so this
  # fires once per user edit.
  shiny::observeEvent(
    r_state(),
    {
      if (self_write$active) {
        self_write$active <- FALSE
      } else {
        session$sendCustomMessage(
          paste0(name, "-block-update"),
          list(
            id    = session$ns(input_name),
            state = normalize_state(r_state())
          )
        )
      }
    },
    ignoreInit = ignore_init
  )

  list(fields = r_fields, state = r_state)
}
