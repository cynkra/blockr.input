/**
 * EditBlock — JS-driven CRUD block over an upstream tibble.
 *
 * Single-select row picker + type-aware form for editable cols + cogwheel for
 * key/display/editable column config. "+ Add row" / "Delete row" / "Apply"
 * actions. Output state composes into rows_upsert + rows_delete on the R side.
 *
 * Depends on: blockr-core.js, blockr-select.js, blockr-input.js
 */
(() => {
  'use strict';

  const SENTINEL_NEW = '__edit_block_new__';

  class EditBlock {
    constructor(el) {
      this.el = el;
      this._callback = null;
      this._submitted = false;

      // Persisted state (round-trips with R)
      this._state = {
        key_col: null,
        display_cols: [],
        editable_cols: [],
        upserts: [],
        deletes: []
      };

      // Transient UI state (NOT persisted)
      this._columns = [];          // [{name, type, choices?, unique_count, n_rows}]
      this._columnByName = {};
      this._rows = [];             // [{key, label}] from upstream
      this._rowsByKey = {};
      this._selectedKey = null;    // currently shown in form (string or null)
      this._mode = 'edit';         // 'edit' | 'new'
      this._formValues = {};       // current form field values keyed by column name
      this._fieldEls = {};         // { colName: { input, errorEl, type } }
      this._fieldErrors = {};      // { colName: errorMsg }

      this._buildDOM();
    }

    // ---------------------------------------------------------------- DOM

    _buildDOM() {
      this.card = document.createElement('div');
      this.card.className = 'eb-card';
      this.el.appendChild(this.card);

      // Gear header
      const gearHeader = document.createElement('div');
      gearHeader.className = 'blockr-gear-header';
      this.gearBtn = document.createElement('button');
      this.gearBtn.type = 'button';
      this.gearBtn.className = 'blockr-gear-btn';
      this.gearBtn.innerHTML = Blockr.icons.gear;
      this.gearBtn.title = 'Advanced settings';
      this.gearBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._togglePopover();
      });
      gearHeader.appendChild(this.gearBtn);
      this.card.appendChild(gearHeader);

      // Row picker (single-select)
      this.pickerWrap = document.createElement('div');
      this.pickerWrap.className = 'eb-picker-wrap blockr-select--bordered';
      const pickerLabel = document.createElement('label');
      pickerLabel.className = 'blockr-label';
      pickerLabel.textContent = 'Row';
      this.pickerWrap.appendChild(pickerLabel);
      this.pickerHost = document.createElement('div');
      this.pickerWrap.appendChild(this.pickerHost);
      this.card.appendChild(this.pickerWrap);
      this._buildPicker();

      // Stale-row banner (hidden until needed)
      this.staleBanner = document.createElement('div');
      this.staleBanner.className = 'eb-stale-banner';
      this.staleBanner.style.display = 'none';
      this.card.appendChild(this.staleBanner);

      // Form fields container (rebuilt when editable_cols change)
      this.formArea = document.createElement('div');
      this.formArea.className = 'eb-fields';
      this.card.appendChild(this.formArea);

      // Action footer (matches blockr.docs blockr-add-row + blockr-add-link
      // pattern used across blockr.dplyr).
      const actions = document.createElement('div');
      actions.className = 'eb-actions blockr-add-row';

      const leftActions = document.createElement('div');
      leftActions.className = 'eb-actions-left';
      actions.appendChild(leftActions);

      this.addBtn = document.createElement('span');
      this.addBtn.className = 'blockr-add-link';
      this.addBtn.innerHTML =
        `<span class="blockr-add-icon">${Blockr.icons.plus}</span> Add row`;
      this.addBtn.addEventListener('click', () => {
        if (!this.addBtn.classList.contains('eb-disabled')) this._onAddRow();
      });
      leftActions.appendChild(this.addBtn);

      this.deleteBtn = document.createElement('span');
      this.deleteBtn.className = 'blockr-add-link eb-delete-link';
      this.deleteBtn.innerHTML =
        `<span class="blockr-add-icon">${Blockr.icons.x}</span> Delete row`;
      this.deleteBtn.addEventListener('click', () => {
        if (!this.deleteBtn.classList.contains('eb-disabled')) this._onDeleteRow();
      });
      leftActions.appendChild(this.deleteBtn);

      this.applyBtn = document.createElement('button');
      this.applyBtn.type = 'button';
      this.applyBtn.className = 'blockr-pill eb-apply-btn';
      this.applyBtn.textContent = 'Apply';
      this.applyBtn.addEventListener('click', () => this._onApply());
      actions.appendChild(this.applyBtn);

      this.card.appendChild(actions);

      // Popover
      this._buildPopover();

      // Close popover on outside click
      document.addEventListener('click', (e) => {
        if (this._popoverOpen && this.popoverEl &&
            !this.popoverEl.contains(e.target) &&
            !this.gearBtn.contains(e.target)) {
          this._closePopover();
        }
      });

      this._renderForm();
      this._refreshActionState();
    }

    _buildPicker() {
      this.pickerHost.textContent = '';
      const opts = this._pickerOptions();
      this._picker = Blockr.Select.single(this.pickerHost, {
        options: opts,
        selected: this._selectedKey != null ? String(this._selectedKey) : '',
        placeholder: 'Pick a row…',
        onChange: (val) => this._onPickRow(val)
      });
    }

    _pickerOptions() {
      const deletedSet = new Set(this._state.deletes.map(String));
      return this._rows
        .filter((r) => !deletedSet.has(String(r.key)))
        .map((r) => {
          const keyStr = String(r.key);
          const baseLabel = r.label != null ? String(r.label) : keyStr;
          // Blockr.Select shows `value` prominently and `label` as a faint
          // suffix. Use the key as the value (so onChange returns the key)
          // and the composed display as the suffix label, dropping the key
          // from the suffix to avoid duplication.
          const suffix = baseLabel.startsWith(keyStr + ' — ')
            ? baseLabel.slice(keyStr.length + 3)
            : (baseLabel === keyStr ? '' : baseLabel);
          const upserted = this._upsertIndexFor(r.key) >= 0;
          const finalSuffix = upserted ? `${suffix}${suffix ? ' ' : ''}*` : suffix;
          return { value: keyStr, label: finalSuffix };
        });
    }

    // ---------------------------------------------------------------- Popover

    _buildPopover() {
      this.popoverEl = document.createElement('div');
      this.popoverEl.className = 'blockr-popover eb-popover';
      this.popoverEl.style.display = 'none';

      // Key column (single-select)
      const keyRow = document.createElement('div');
      keyRow.className = 'blockr-popover-row';
      const keyLabel = document.createElement('label');
      keyLabel.className = 'blockr-popover-label';
      keyLabel.textContent = 'Key column';
      keyRow.appendChild(keyLabel);
      this._keyColHost = document.createElement('div');
      this._keyColHost.className = 'eb-popover-col-host';
      keyRow.appendChild(this._keyColHost);
      this.popoverEl.appendChild(keyRow);

      // Display columns (multi-select)
      const dispRow = document.createElement('div');
      dispRow.className = 'blockr-popover-row';
      const dispLabel = document.createElement('label');
      dispLabel.className = 'blockr-popover-label';
      dispLabel.textContent = 'Display columns';
      dispRow.appendChild(dispLabel);
      this._dispHost = document.createElement('div');
      this._dispHost.className = 'eb-popover-col-host';
      dispRow.appendChild(this._dispHost);
      this.popoverEl.appendChild(dispRow);

      // Editable columns (multi-select)
      const editRow = document.createElement('div');
      editRow.className = 'blockr-popover-row';
      const editLabel = document.createElement('label');
      editLabel.className = 'blockr-popover-label';
      editLabel.textContent = 'Editable columns';
      editRow.appendChild(editLabel);
      this._editHost = document.createElement('div');
      this._editHost.className = 'eb-popover-col-host';
      editRow.appendChild(this._editHost);
      this.popoverEl.appendChild(editRow);

      // Status row (key uniqueness warning, etc.)
      this._popoverStatus = document.createElement('div');
      this._popoverStatus.className = 'eb-popover-status';
      this.popoverEl.appendChild(this._popoverStatus);

      this.card.appendChild(this.popoverEl);
      this._renderPopoverFields();
    }

    _renderPopoverFields() {
      const colOptions = this._columns.map((c) => ({ value: c.name, label: c.type }));

      // Key column picker (single)
      this._keyColHost.textContent = '';
      this._keyColSelect = Blockr.Select.single(this._keyColHost, {
        options: colOptions,
        selected: this._state.key_col || '',
        placeholder: 'Pick a key column…',
        onChange: (val) => {
          this._state.key_col = val || null;
          this._refreshKeyColStatus();
        }
      });

      // Display columns picker (multi) — exclude key col
      const nonKeyOpts = colOptions.filter(
        (o) => o.value !== this._state.key_col
      );
      this._dispHost.textContent = '';
      this._dispSelect = Blockr.Select.multi(this._dispHost, {
        options: nonKeyOpts,
        selected: this._state.display_cols.slice(),
        placeholder: 'Optional display columns…',
        reorderable: true,
        onChange: (selected) => {
          this._state.display_cols = selected;
        }
      });

      // Editable columns picker (multi) — exclude key col
      this._editHost.textContent = '';
      this._editSelect = Blockr.Select.multi(this._editHost, {
        options: nonKeyOpts,
        selected: this._state.editable_cols.slice(),
        placeholder: 'Editable columns…',
        reorderable: false,
        onChange: (selected) => {
          this._state.editable_cols = selected;
          this._renderForm();
        }
      });

      this._refreshKeyColStatus();
    }

    _refreshKeyColStatus() {
      if (!this._popoverStatus) return;
      this._popoverStatus.textContent = '';
      const key = this._state.key_col;
      if (!key) return;
      const meta = this._columnByName[key];
      if (!meta) return;
      if (meta.unique_count != null && meta.n_rows != null &&
          meta.unique_count !== meta.n_rows && meta.n_rows > 0) {
        this._popoverStatus.textContent =
          `Warning: '${key}' has duplicate values; rows_upsert requires a unique key.`;
        this._popoverStatus.classList.add('eb-popover-status--warn');
      } else {
        this._popoverStatus.classList.remove('eb-popover-status--warn');
      }
    }

    _togglePopover() {
      if (this._popoverOpen) this._closePopover();
      else this._openPopover();
    }

    _openPopover() {
      this.popoverEl.style.display = 'block';
      this._popoverOpen = true;
    }

    _closePopover() {
      this.popoverEl.style.display = 'none';
      this._popoverOpen = false;
    }

    // ---------------------------------------------------------------- Form

    _renderForm() {
      this.formArea.textContent = '';
      this._fieldEls = {};
      this._fieldErrors = {};

      const editable = this._state.editable_cols;

      if (this._mode === 'new') {
        // In "new row" mode, key field is editable text input
        if (this._state.key_col) {
          const meta = this._columnByName[this._state.key_col];
          this._appendField(this._state.key_col, meta, /*isKey*/ true);
        }
      }

      for (const colName of editable) {
        const meta = this._columnByName[colName];
        if (!meta) continue;
        this._appendField(colName, meta, /*isKey*/ false);
      }

      this._populateFormFromState();
    }

    _appendField(colName, meta, isKey) {
      const row = document.createElement('div');
      row.className = 'eb-field';
      const label = document.createElement('label');
      label.className = 'blockr-label';
      label.textContent = colName + (isKey ? ' (key)' : '');
      row.appendChild(label);

      const inputWrap = document.createElement('div');
      inputWrap.className = 'eb-field-input';
      row.appendChild(inputWrap);

      const errorEl = document.createElement('div');
      errorEl.className = 'eb-field-error';
      row.appendChild(errorEl);

      let input;
      const type = meta?.type || 'chr';

      if (meta?.choices && meta.choices.length > 0 && !isKey) {
        // Dropdown
        const choiceOpts = [{ value: '', label: '' }].concat(
          meta.choices.map((c) => ({ value: String(c), label: '' }))
        );
        const sel = Blockr.Select.single(inputWrap, {
          options: choiceOpts,
          selected: '',
          placeholder: 'Select…',
          onChange: (val) => this._onFieldChange(colName, val)
        });
        input = { kind: 'select', api: sel, get: () => sel.getValue(), set: (v) => sel.setOptions(choiceOpts, v ?? '') };
      } else if (type === 'int' || type === 'dbl') {
        const el = document.createElement('input');
        el.type = 'number';
        el.className = 'blockr-num-input';
        if (type === 'int') el.step = '1';
        el.addEventListener('input', () => this._onFieldChange(colName, el.value));
        inputWrap.appendChild(el);
        input = { kind: 'num', el, get: () => el.value, set: (v) => { el.value = v ?? ''; } };
      } else if (type === 'date') {
        const el = document.createElement('input');
        el.type = 'date';
        el.className = 'blockr-text-input';
        el.addEventListener('input', () => this._onFieldChange(colName, el.value));
        inputWrap.appendChild(el);
        input = { kind: 'date', el, get: () => el.value, set: (v) => { el.value = v ?? ''; } };
      } else if (type === 'lgl') {
        const el = document.createElement('input');
        el.type = 'checkbox';
        el.className = 'eb-checkbox';
        el.addEventListener('change', () => this._onFieldChange(colName, el.checked));
        inputWrap.appendChild(el);
        input = { kind: 'lgl', el, get: () => el.checked, set: (v) => { el.checked = !!v; } };
      } else {
        const el = document.createElement('input');
        el.type = 'text';
        el.className = 'blockr-text-input';
        el.addEventListener('input', () => this._onFieldChange(colName, el.value));
        inputWrap.appendChild(el);
        input = { kind: 'text', el, get: () => el.value, set: (v) => { el.value = v == null ? '' : String(v); } };
      }

      this._fieldEls[colName] = { input, errorEl, type, isKey };
      this.formArea.appendChild(row);
    }

    _populateFormFromState() {
      // Pick source of values: pending upsert (if any) > upstream row > blank
      const key = this._effectiveKey();
      let source = {};

      if (this._mode === 'new') {
        source = { ...this._formValues };
      } else if (key != null) {
        const upIdx = this._upsertIndexFor(key);
        if (upIdx >= 0) {
          source = { ...this._state.upserts[upIdx] };
        } else if (this._rowsByKey[key]?.values) {
          source = { ...this._rowsByKey[key].values };
        }
      }

      this._formValues = { ...source };

      for (const [colName, ent] of Object.entries(this._fieldEls)) {
        const val = source[colName];
        ent.input.set(val);
      }
      this._renderErrors();
    }

    _onFieldChange(colName, value) {
      this._formValues[colName] = value;
      this._syncFormToState();
      this._renderErrors();
      this._refreshActionState();
    }

    _syncFormToState() {
      const key = this._effectiveKey();
      if (key == null || key === '') return;

      const editable = this._state.editable_cols;
      const row = { [this._state.key_col]: this._coerceKey(key) };
      for (const c of editable) {
        if (Object.prototype.hasOwnProperty.call(this._formValues, c)) {
          row[c] = this._coerceField(c, this._formValues[c]);
        }
      }

      const idx = this._upsertIndexFor(key);
      if (idx >= 0) {
        this._state.upserts[idx] = row;
      } else {
        this._state.upserts = this._state.upserts.concat([row]);
      }
    }

    _renderErrors() {
      for (const [colName, ent] of Object.entries(this._fieldEls)) {
        const err = this._fieldErrors[colName];
        ent.errorEl.textContent = err || '';
        ent.errorEl.style.display = err ? 'block' : 'none';
      }
    }

    // ---------------------------------------------------------------- Actions

    _onPickRow(val) {
      this._mode = 'edit';
      this._selectedKey = (val == null || val === '') ? null : val;
      this._renderForm();
      this._refreshActionState();
      this._refreshStaleBanner();
    }

    _onAddRow() {
      this._mode = 'new';
      this._selectedKey = null;
      this._formValues = {};
      this._renderForm();
      this._refreshActionState();
      this._refreshStaleBanner();
    }

    _onDeleteRow() {
      const key = this._effectiveKey();
      if (key == null || key === '') return;
      if (this._mode === 'new') {
        // Drop the in-progress new row entirely
        this._removeUpsert(key);
        this._mode = 'edit';
        this._formValues = {};
        this._renderForm();
        this._refreshActionState();
        return;
      }
      // Mark for deletion + remove any pending upsert for this key
      this._removeUpsert(key);
      const keyStr = String(key);
      if (!this._state.deletes.map(String).includes(keyStr)) {
        this._state.deletes = this._state.deletes.concat([this._coerceKey(key)]);
      }
      this._selectedKey = null;
      this._buildPicker(); // refresh option list (delete hides the row)
      this._renderForm();
      this._refreshActionState();
    }

    _onApply() {
      if (!this._validate()) {
        this._renderErrors();
        return;
      }
      this._submitted = true;
      this._callback?.(true);
    }

    // ---------------------------------------------------------------- Validation

    _validate() {
      this._fieldErrors = {};
      let ok = true;

      // Validate the in-progress row if any
      const key = this._effectiveKey();
      if (key == null || (this._mode === 'new' && (key === '' || key == null))) {
        // No active row in progress — only deletes pending. That's fine.
        return ok;
      }

      // Required + type for the active row
      for (const colName of this._state.editable_cols) {
        const ent = this._fieldEls[colName];
        if (!ent) continue;
        const raw = this._formValues[colName];
        const isInsert = this._mode === 'new';
        if (isInsert && (raw === '' || raw == null)) {
          this._fieldErrors[colName] = 'Required for new row';
          ok = false;
          continue;
        }
        const typeErr = this._typeError(ent.type, raw);
        if (typeErr) {
          this._fieldErrors[colName] = typeErr;
          ok = false;
        }
      }

      // Duplicate key check for inserts
      if (this._mode === 'new') {
        const keyStr = String(key);
        // Existing in upstream?
        if (this._rowsByKey[keyStr] && !this._state.deletes.map(String).includes(keyStr)) {
          if (this._fieldEls[this._state.key_col]) {
            this._fieldErrors[this._state.key_col] = 'Key already exists in source';
          }
          ok = false;
        }
        // Already in pending upserts (other than this one)?
        const matches = this._state.upserts.filter(
          (r) => String(r[this._state.key_col]) === keyStr
        );
        if (matches.length > 1) {
          if (this._fieldEls[this._state.key_col]) {
            this._fieldErrors[this._state.key_col] = 'Duplicate key in pending rows';
          }
          ok = false;
        }
      }

      return ok;
    }

    _typeError(type, raw) {
      if (raw === '' || raw == null) return null;
      if (type === 'int') {
        if (!/^-?\d+$/.test(String(raw))) return 'Must be an integer';
      } else if (type === 'dbl') {
        if (isNaN(Number(raw))) return 'Must be a number';
      } else if (type === 'date') {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(raw))) return 'Must be YYYY-MM-DD';
      }
      return null;
    }

    _coerceField(colName, raw) {
      const meta = this._columnByName[colName];
      const type = meta?.type || 'chr';
      if (raw === '' || raw == null) return null;
      if (type === 'int') return parseInt(raw, 10);
      if (type === 'dbl') return Number(raw);
      if (type === 'lgl') return !!raw;
      return raw;
    }

    _coerceKey(raw) {
      const meta = this._columnByName[this._state.key_col];
      const type = meta?.type || 'chr';
      if (raw === '' || raw == null) return null;
      if (type === 'int') return parseInt(raw, 10);
      if (type === 'dbl') return Number(raw);
      return raw;
    }

    // ---------------------------------------------------------------- Stale

    _refreshStaleBanner() {
      const stale = this._staleKeys();
      if (stale.length === 0) {
        this.staleBanner.style.display = 'none';
        this.staleBanner.textContent = '';
        return;
      }
      this.staleBanner.textContent =
        `Pending edits for ${stale.length} row(s) no longer in source. ` +
        `Discard them to apply the rest, or click Apply to insert as new rows.`;
      this.staleBanner.style.display = 'block';
    }

    _staleKeys() {
      const live = new Set(this._rows.map((r) => String(r.key)));
      return this._state.upserts
        .map((r) => String(r[this._state.key_col]))
        .filter((k) => !live.has(k));
    }

    // ---------------------------------------------------------------- Helpers

    _effectiveKey() {
      if (this._mode === 'new') {
        return this._formValues[this._state.key_col] ?? null;
      }
      return this._selectedKey;
    }

    _upsertIndexFor(key) {
      if (key == null || this._state.key_col == null) return -1;
      const target = String(key);
      return this._state.upserts.findIndex(
        (r) => String(r[this._state.key_col]) === target
      );
    }

    _removeUpsert(key) {
      const idx = this._upsertIndexFor(key);
      if (idx >= 0) {
        this._state.upserts = this._state.upserts.filter((_, i) => i !== idx);
      }
    }

    _refreshActionState() {
      const haveKey = !!this._state.key_col;
      const haveRow = this._effectiveKey() != null && this._effectiveKey() !== '';
      this.addBtn.classList.toggle('eb-disabled', !haveKey);
      this.deleteBtn.classList.toggle('eb-disabled', !haveRow);
      this.applyBtn.disabled = !haveKey;
    }

    // ---------------------------------------------------------------- Lifecycle

    _compose() {
      // Ensure deletes are deduped & strings normalized
      const out = {
        key_col: this._state.key_col,
        display_cols: this._state.display_cols.slice(),
        editable_cols: this._state.editable_cols.slice(),
        upserts: this._state.upserts.slice(),
        deletes: this._state.deletes.slice()
      };
      return out;
    }

    getValue() {
      if (!this._submitted) return null;
      return this._compose();
    }

    setState(state, silent) {
      if (!state) return;
      this._state = {
        key_col: state.key_col ?? null,
        display_cols: (state.display_cols || []).slice(),
        editable_cols: (state.editable_cols || []).slice(),
        upserts: (state.upserts || []).map((r) => ({ ...r })),
        deletes: (state.deletes || []).slice()
      };
      this._mode = 'edit';
      this._selectedKey = null;
      this._formValues = {};

      this._renderPopoverFields();
      this._buildPicker();
      this._renderForm();
      this._refreshActionState();
      this._refreshStaleBanner();
    }

    updateColumns(meta) {
      this._columns = (meta || []).slice();
      this._columnByName = {};
      for (const c of this._columns) this._columnByName[c.name] = c;

      // Drop stale references
      const colSet = new Set(this._columns.map((c) => c.name));
      if (this._state.key_col && !colSet.has(this._state.key_col)) {
        this._state.key_col = null;
      }
      this._state.display_cols = this._state.display_cols.filter((c) => colSet.has(c));
      this._state.editable_cols = this._state.editable_cols.filter((c) => colSet.has(c));
      this._state.upserts = this._state.upserts.map((r) => {
        const out = {};
        for (const k of Object.keys(r)) if (colSet.has(k)) out[k] = r[k];
        return out;
      });

      this._renderPopoverFields();
      this._renderForm();
      this._refreshActionState();
    }

    updateRows(rows) {
      this._rows = (rows || []).map((r) => ({
        key: r.key,
        label: r.label,
        values: r.values || {}
      }));
      this._rowsByKey = {};
      for (const r of this._rows) this._rowsByKey[String(r.key)] = r;

      this._buildPicker();
      this._refreshStaleBanner();
      // If currently selected row is gone from upstream, clear selection
      if (this._selectedKey != null && !this._rowsByKey[String(this._selectedKey)]) {
        this._selectedKey = null;
        this._renderForm();
        this._refreshActionState();
      }
    }
  }

  // ---------------------------------------------------------------- Binding

  const binding = new Shiny.InputBinding();

  Object.assign(binding, {
    find: (scope) => $(scope).find('.edit-block-container'),
    getId: (el) => el.id || null,
    getValue: (el) => el._block?.getValue() ?? null,
    setValue: (el, value) => el._block?.setState(value),
    subscribe: (el, callback) => {
      if (el._block) el._block._callback = () => callback(true);
    },
    unsubscribe: (el) => {
      if (el._block) el._block._callback = null;
    },
    initialize: (el) => {
      el._block = new EditBlock(el);
      if (el._pendingColumns) { el._block.updateColumns(el._pendingColumns); delete el._pendingColumns; }
      if (el._pendingRows)    { el._block.updateRows(el._pendingRows);       delete el._pendingRows; }
      if (el._pendingState)   { el._block.setState(el._pendingState);        delete el._pendingState; }
    },
    receiveMessage: (el, data) => {
      if (data.state) el._block?.setState(data.state);
    }
  });

  Shiny.inputBindings.register(binding, 'blockr.edit');

  Shiny.addCustomMessageHandler('edit-columns', (msg) => {
    const el = document.getElementById(msg.id);
    if (el?._block)      el._block.updateColumns(msg.columns);
    else if (el)         el._pendingColumns = msg.columns;
  });

  Shiny.addCustomMessageHandler('edit-rows', (msg) => {
    const el = document.getElementById(msg.id);
    if (el?._block)      el._block.updateRows(msg.rows);
    else if (el)         el._pendingRows = msg.rows;
  });

  Shiny.addCustomMessageHandler('edit-block-update', (msg) => {
    const el = document.getElementById(msg.id);
    if (el?._block)      el._block.setState(msg.state, true);
    else if (el)         el._pendingState = msg.state;
  });
})();
