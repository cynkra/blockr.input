/**
 * GridBlock — JS-driven multi-row data entry block (Tabulator-backed).
 *
 * Schema is the upstream tibble. The grid renders upstream rows + any
 * pending edits/inserts; on change, computes a diff (upserts + deletes)
 * against the upstream snapshot and pushes that as state. R composes the
 * generated expression as `data |> rows_delete |> rows_upsert`, identical
 * in shape to new_edit_block().
 *
 * Depends on: Tabulator (vendored), Blockr.Select.single (cogwheel picker).
 */
(() => {
  'use strict';

  class GridBlock {
    constructor(el) {
      this.el = el;
      this._callback = null;
      this._submitted = false;

      // Persisted state (round-trips with R)
      this._state = {
        key_col: null,
        upserts: [],
        deletes: []
      };

      // Transient
      this._columns = [];           // [{name, type, choices?, unique_count}]
      this._upstreamByKey = {};     // key string → full upstream row values
      this._table = null;
      this._suppressChange = false;
      this._popoverOpen = false;
      this._keySelect = null;       // Blockr.Select instance for key_col picker

      this._buildShell();
      this._buildPopover();

      // Close popover on outside click
      document.addEventListener('click', (e) => {
        if (!this._popoverOpen) return;
        if (this.popover.contains(e.target) || this.gearBtn.contains(e.target)) return;
        this._closePopover();
      });
    }

    // ----------------------------------------------------------------- DOM

    _buildShell() {
      this.card = document.createElement('div');
      this.card.className = 'gb-card';
      this.el.appendChild(this.card);

      // Gear header (matches edit-block)
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

      // Grid host
      this.gridHost = document.createElement('div');
      this.gridHost.className = 'gb-host';
      this.card.appendChild(this.gridHost);

      // Action footer
      const actions = document.createElement('div');
      actions.className = 'gb-actions blockr-add-row';

      const leftActions = document.createElement('div');
      leftActions.className = 'gb-actions-left';
      actions.appendChild(leftActions);

      this.addBtn = document.createElement('span');
      this.addBtn.className = 'blockr-add-link';
      this.addBtn.innerHTML =
        `<span class="blockr-add-icon">${Blockr.icons.plus}</span> Add row`;
      this.addBtn.addEventListener('click', () => {
        if (!this.addBtn.classList.contains('gb-disabled')) this._onAddRow();
      });
      leftActions.appendChild(this.addBtn);

      this.delBtn = document.createElement('span');
      this.delBtn.className = 'blockr-add-link gb-delete-link gb-disabled';
      this.delBtn.innerHTML =
        `<span class="blockr-add-icon">${Blockr.icons.x}</span> Delete selected`;
      this.delBtn.addEventListener('click', () => {
        if (!this.delBtn.classList.contains('gb-disabled')) this._onDeleteSelected();
      });
      leftActions.appendChild(this.delBtn);

      this.statusEl = document.createElement('span');
      this.statusEl.className = 'gb-status';
      this.statusEl.textContent = 'ready';
      leftActions.appendChild(this.statusEl);

      this.applyBtn = document.createElement('button');
      this.applyBtn.type = 'button';
      this.applyBtn.className = 'blockr-pill gb-apply-btn';
      this.applyBtn.textContent = 'Apply';
      this.applyBtn.disabled = true;
      this.applyBtn.addEventListener('click', () => this._onApply());
      actions.appendChild(this.applyBtn);

      this.card.appendChild(actions);
    }

    _buildPopover() {
      this.popover = document.createElement('div');
      this.popover.className = 'blockr-popover gb-popover';
      this.popover.style.display = 'none';

      const title = document.createElement('div');
      title.className = 'blockr-popover-title';
      title.textContent = 'Settings';
      this.popover.appendChild(title);

      // Key column picker
      const keyWrap = document.createElement('div');
      keyWrap.className = 'gb-popover-field';
      const keyLabel = document.createElement('label');
      keyLabel.className = 'blockr-label';
      keyLabel.textContent = 'Key column';
      keyWrap.appendChild(keyLabel);
      this.keyHost = document.createElement('div');
      keyWrap.appendChild(this.keyHost);
      this.popover.appendChild(keyWrap);

      this.card.appendChild(this.popover);
    }

    _togglePopover() {
      this._popoverOpen ? this._closePopover() : this._openPopover();
    }

    _openPopover() {
      this._popoverOpen = true;
      this.popover.style.display = 'block';
      this._renderKeyPicker();
    }

    _closePopover() {
      this._popoverOpen = false;
      this.popover.style.display = 'none';
    }

    _renderKeyPicker() {
      // (Re)build the Blockr.Select for the key column.
      const opts = this._columns.map(c => ({ value: c.name, label: c.name }));
      if (this._keySelect && typeof this._keySelect.destroy === 'function') {
        this._keySelect.destroy();
      }
      this.keyHost.innerHTML = '';
      this._keySelect = Blockr.Select.single(this.keyHost, {
        options: opts,
        selected: this._state.key_col || '',
        placeholder: 'Pick key column…',
        onChange: (value) => {
          // Switching key invalidates the current diff because
          // _upstreamByKey is keyed by the old column. Clear pending
          // upserts/deletes; R will re-push grid-rows under the new key,
          // and the user resumes from a clean upstream snapshot.
          this._state.key_col = value || null;
          this._state.upserts = [];
          this._state.deletes = [];
          this._onChange();
        }
      });
    }

    // -------------------------------------------------------- Tabulator wiring

    _columnDef(c) {
      const base = {
        title: c.name,
        field: c.name,
        headerSort: false,
        resizable: true
      };
      switch (c.type) {
        case 'int':
          return { ...base, editor: 'number', editorParams: { step: 1 },
                   validator: ['integer'] };
        case 'dbl':
          return { ...base, editor: 'number' };
        case 'date':
          // HTML5 native <input type="date"> returns yyyy-MM-dd, so no
          // editorParams.format is needed (which would require Luxon).
          return {
            ...base,
            editor: 'date',
            validator: [{
              type: function (cell, value) {
                if (value == null || value === '') return true;
                return /^\d{4}-\d{2}-\d{2}$/.test(value)
                       && !isNaN(new Date(value).getTime());
              },
              parameters: {}
            }]
          };
        case 'lgl':
          return { ...base, editor: 'tickCross', formatter: 'tickCross' };
        case 'factor':
          return {
            ...base,
            editor: 'list',
            editorParams: { values: c.choices || [], autocomplete: true },
            validator: [{
              type: function (cell, value) {
                if (value == null || value === '') return true;
                return (c.choices || []).includes(value);
              },
              parameters: {}
            }]
          };
        case 'datetime':
          return {
            ...base,
            editor: 'input',
            validator: [{
              type: function (cell, value) {
                if (value == null || value === '') return true;
                return !isNaN(new Date(value).getTime());
              },
              parameters: {}
            }]
          };
        case 'chr':
        default:
          if (c.choices && c.choices.length > 0) {
            return { ...base, editor: 'list',
                     editorParams: { values: c.choices, autocomplete: true,
                                     freetext: true } };
          }
          return { ...base, editor: 'input' };
      }
    }

    _tsvParser(clipboard) {
      const lines = clipboard.split(/\r?\n/).filter(Boolean);
      const order = this._columns.map(c => c.name);
      return lines.map(line => {
        const cells = line.split('\t');
        const row = {};
        order.forEach((f, i) => { row[f] = cells[i] ?? ''; });
        return row;
      });
    }

    _buildTable() {
      if (this._table) {
        try { this._table.destroy(); } catch (_) {}
        this._table = null;
      }
      this._tableReady = false;
      if (this._columns.length === 0) return;

      const cols = [
        { formatter: 'rowSelection', titleFormatter: 'rowSelection',
          hozAlign: 'center', headerSort: false, width: 30, frozen: true,
          clipboard: false }
      ].concat(this._columns.map(c => this._columnDef(c)));

      const initialData = this._materializeRows();

      this._table = new Tabulator(this.gridHost, {
        data: initialData,
        columns: cols,
        layout: 'fitColumns',
        // reactiveData off: we own the row state and pass clones to Tabulator
        // each time. With reactiveData on, Tabulator mutates references and
        // poisons our upstream snapshot.
        reactiveData: false,
        selectableRows: true,
        clipboard: true,
        clipboardPasteAction: 'replace',
        clipboardPasteParser: c => this._tsvParser(c),
        clipboardCopyRowRange: 'selected',
        clipboardCopyConfig: { columnHeaders: false },
        validationMode: 'highlight',
        placeholder: 'Empty',
        // Auto-height: shrink to content, cap at ~tens of rows of scroll.
        maxHeight: '480px',
        rowFormatter: (row) => this._classifyRow(row)
      });

      const onChange = () => this._onChange();
      ['cellEdited', 'rowAdded', 'rowDeleted',
       'dataChanged', 'dataLoaded', 'clipboardPasted']
        .forEach(ev => this._table.on(ev, onChange));
      this._table.on('rowSelectionChanged', () => this._refreshDeleteBtn());
      this._table.on('tableBuilt', () => {
        this._tableReady = true;
        // Flush any data that arrived before the table was ready.
        if (this._pendingTableData) {
          const d = this._pendingTableData;
          this._pendingTableData = null;
          this._suppressChange = true;
          try { this._table.setData(d).catch(() => {}); }
          finally { this._suppressChange = false; }
        }
        onChange();
      });
    }

    _safeSetData(rows) {
      if (!this._table) return;
      if (!this._tableReady) {
        this._pendingTableData = rows;
        return;
      }
      this._table.setData(rows).catch(() => {});
    }

    // Build the rows the grid should display: upstream rows (minus deletes),
    // with matching upserts patched on top, plus all inserts.
    // CRITICAL: clone every row. Tabulator may mutate refs; if those alias
    // _upstreamByKey, the snapshot drifts and the diff is silently broken.
    _materializeRows() {
      const key = this._state.key_col;
      if (!key) {
        if (this._state.upserts.length > 0) {
          return this._state.upserts.map(r => ({ ...r }));
        }
        return Object.values(this._upstreamByKey).map(r => ({ ...r }));
      }

      const deletedKeys = new Set(this._state.deletes.map(String));
      const keyedUpserts = {};
      const unkeyedUpserts = [];
      for (const u of this._state.upserts) {
        const k = u[key];
        if (k != null && k !== '') keyedUpserts[String(k)] = u;
        else unkeyedUpserts.push(u);
      }

      const out = [];
      for (const upKey of Object.keys(this._upstreamByKey)) {
        const base = { ...(keyedUpserts[upKey] ?? this._upstreamByKey[upKey]) };
        if (deletedKeys.has(upKey)) base._gb_deleted = true;
        out.push(base);
      }
      // Inserts: keyed upserts whose key isn't in upstream.
      for (const k of Object.keys(keyedUpserts)) {
        if (!(k in this._upstreamByKey)) out.push({ ...keyedUpserts[k] });
      }
      // Unkeyed upserts (seeded blank row, or freshly-added row before
      // the user fills the key).
      for (const u of unkeyedUpserts) out.push({ ...u });
      return out;
    }

    // Recompute upserts/deletes from grid contents. Does NOT submit; submit
    // happens only on Apply (matches edit-block: explicit-start, then auto).
    _recomputeDiff() {
      if (!this._table) return { ok: false, errors: 0, rowCount: 0 };
      this._table.validate();
      const data = this._table.getData();
      const errors = this._table.getInvalidCells();
      const key = this._state.key_col;

      if (!key) return { ok: false, errors: errors.length,
                          rowCount: data.length, key: null };

      const currentKeys = new Set();
      const explicitDeletes = new Set();
      const upserts = [];
      for (const row of data) {
        const k = row[key];
        if (k == null || k === '') continue;
        const ks = String(k);
        if (row._gb_deleted) { explicitDeletes.add(ks); continue; }
        currentKeys.add(ks);
        const upstream = this._upstreamByKey[ks];
        // Strip any internal markers before comparing / emitting.
        const clean = { ...row }; delete clean._gb_deleted;
        if (!upstream) {
          upserts.push(clean);
        } else {
          const changed = this._columns.some(c =>
            this._normalizeForCompare(clean[c.name]) !==
            this._normalizeForCompare(upstream[c.name])
          );
          if (changed) upserts.push(clean);
        }
      }
      const deletes = [];
      for (const k of Object.keys(this._upstreamByKey)) {
        if (!currentKeys.has(k) || explicitDeletes.has(k)) {
          deletes.push(this._upstreamByKey[k][key]);
        }
      }
      this._state.upserts = upserts;
      this._state.deletes = deletes;

      return {
        ok: errors.length === 0,
        errors: errors.length,
        rowCount: data.length,
        key
      };
    }

    _reclassifyAllRows() {
      if (!this._table) return;
      // Tabulator's rowFormatter only fires on render; after cellEdited the
      // data changes but classes stay stale. Re-run classifyRow on every
      // visible row so the amber/green/red indicators stay in sync.
      for (const r of this._table.getRows()) this._classifyRow(r);
    }

    _onChange() {
      if (this._suppressChange) return;
      const r = this._recomputeDiff();
      const dirty = (this._state.upserts.length + this._state.deletes.length) > 0;
      this._reclassifyAllRows();

      // Apply: enabled iff there's a key column AND validation passes.
      // Same shape as edit-block; click is a no-op when nothing's pending.
      this.applyBtn.disabled = !(r.ok && !!r.key);

      this._setStatus(
        !r.key         ? 'pick a key column'
        : r.errors > 0 ? `${r.errors} invalid cell(s)`
        : !this._submitted && dirty
                       ? `${this._state.upserts.length} upsert(s), ${this._state.deletes.length} delete(s) — click Apply`
        : !dirty       ? `${r.rowCount} rows, no changes`
        : `${this._state.upserts.length} upsert(s), ${this._state.deletes.length} delete(s) live`,
        r.ok && !!r.key
      );

      // Auto-stream after first Apply (matches edit-block: explicit start,
      // then state flows on every valid change).
      if (this._submitted && r.ok && r.key) this._callback?.(true);
    }

    _onApply() {
      const r = this._recomputeDiff();
      if (!r.ok || !r.key) return;
      this._submitted = true;
      this.applyBtn.disabled = true;
      this._callback?.(true);
    }

    _normalizeForCompare(v) {
      if (v == null) return '';
      if (typeof v === 'string') return v;
      return String(v);
    }

    _setStatus(msg, ok) {
      this.statusEl.textContent = msg;
      this.statusEl.className = 'gb-status ' + (ok ? 'gb-status--ok' : 'gb-status--err');
    }

    // Apply CSS class to each row based on its diff state vs. upstream.
    // Called by Tabulator's rowFormatter on every redraw.
    _classifyRow(row) {
      const el = row.getElement();
      el.classList.remove('gb-row--new', 'gb-row--updated', 'gb-row--deleted');
      const key = this._state.key_col;
      const data = row.getData();
      if (data._gb_deleted) { el.classList.add('gb-row--deleted'); return; }
      if (!key) return;
      const k = data[key];
      if (k == null || k === '') { el.classList.add('gb-row--new'); return; }
      const upstream = this._upstreamByKey[String(k)];
      if (!upstream) { el.classList.add('gb-row--new'); return; }
      const changed = this._columns.some(c =>
        this._normalizeForCompare(data[c.name]) !==
        this._normalizeForCompare(upstream[c.name])
      );
      if (changed) el.classList.add('gb-row--updated');
    }

    _refreshDeleteBtn() {
      const enabled = !!this._table && this._table.getSelectedRows().length > 0;
      this.delBtn.classList.toggle('gb-disabled', !enabled);
    }

    _onAddRow() {
      if (!this._table) return;
      // Pre-fill the key column with a sensible suggestion so the user
      // doesn't have to invent an ID. They can still edit the cell.
      const key = this._state.key_col;
      const keyCol = key ? this._columns.find(c => c.name === key) : null;
      const seed = {};
      if (keyCol) seed[key] = this._suggestKeyValue(keyCol);
      this._table.addRow(seed).catch(() => {});
    }

    _suggestKeyValue(col) {
      // Compute max of upstream + pending-upsert keys and increment.
      // Falls back to '' for types we can't auto-pick (chr, factor).
      if (col.type === 'int' || col.type === 'dbl') {
        let max = 0, found = false;
        for (const u of Object.values(this._upstreamByKey)) {
          const n = Number(u[col.name]);
          if (Number.isFinite(n)) { found = true; if (n > max) max = n; }
        }
        for (const u of this._state.upserts) {
          const n = Number(u[col.name]);
          if (Number.isFinite(n)) { found = true; if (n > max) max = n; }
        }
        if (!found) return col.type === 'int' ? 1 : 1;
        return col.type === 'int' ? Math.floor(max) + 1 : max + 1;
      }
      if (col.type === 'date') {
        return new Date().toISOString().slice(0, 10);
      }
      return '';
    }

    // Soft-delete: rows that exist upstream get marked-deleted (visible
    // with strikethrough); rows local to the grid (no upstream key) are
    // removed outright. Click a marked-deleted row again to undelete.
    _onDeleteSelected() {
      if (!this._table) return;
      const key = this._state.key_col;
      const sel = this._table.getSelectedRows();
      const deletes = new Set(this._state.deletes.map(String));
      const toRemove = [];
      for (const r of sel) {
        const data = r.getData();
        const k = key ? data[key] : null;
        if (k != null && k !== '' && this._upstreamByKey[String(k)]) {
          // toggle in deletes
          if (deletes.has(String(k))) deletes.delete(String(k));
          else deletes.add(String(k));
        } else {
          toRemove.push(r);
        }
      }
      this._state.deletes = Array.from(deletes).map(s => {
        // restore type from upstream
        const u = this._upstreamByKey[s];
        return u ? u[key] : s;
      });
      // Remove purely-local rows (no upstream).
      toRemove.forEach(r => r.delete());
      // Rebuild the visible row set so deleted-but-visible rows show up.
      this._suppressChange = true;
      try { this._safeSetData(this._materializeRows()); }
      finally { this._suppressChange = false; }
      this._refreshDeleteBtn();
      this._onChange();
    }

    // -------------------------------------------------------- Public API

    getValue() {
      if (!this._submitted) return null;
      // Block holds while any cell is invalid (per requirement #2).
      if (this._table && this._table.getInvalidCells().length > 0) return null;
      if (!this._state.key_col) return null;
      return {
        key_col: this._state.key_col,
        upserts: this._state.upserts.slice(),
        deletes: this._state.deletes.slice()
      };
    }

    setState(state) {
      if (!state) return;
      this._state = {
        key_col: state.key_col ?? null,
        upserts: (state.upserts || []).map(r => ({ ...r })),
        deletes: (state.deletes || []).slice()
      };
      this._suppressChange = true;
      try { this._safeSetData(this._materializeRows()); }
      finally { this._suppressChange = false; }
      if (this._popoverOpen) this._renderKeyPicker();
      setTimeout(() => this._onChange(), 0);
    }

    updateColumns(cols, rows, seedBlank) {
      this._columns = (cols || []).slice();
      // Drop key_col if no longer in upstream.
      const colSet = new Set(this._columns.map(c => c.name));
      if (this._state.key_col && !colSet.has(this._state.key_col)) {
        this._state.key_col = null;
      }
      // Auto-pick first column with all-unique values, else first column.
      // JS-side so we don't have to round-trip through R before showing
      // upstream rows.
      if (!this._state.key_col && this._columns.length > 0) {
        const pick = this._columns.find(c =>
          c.unique_count > 0 && c.unique_count === c.n_rows
        ) || this._columns[0];
        this._state.key_col = pick.name;
      }
      // Re-key upstream rows by the (possibly updated) key column.
      this._upstreamByKey = {};
      if (rows && this._state.key_col) {
        for (const r of rows) {
          const k = r[this._state.key_col];
          if (k != null) this._upstreamByKey[String(k)] = { ...r };
        }
      }
      // Drop fields from upserts that aren't in the schema anymore.
      this._state.upserts = (this._state.upserts || []).map(r => {
        const out = {};
        for (const k of Object.keys(r)) if (colSet.has(k)) out[k] = r[k];
        return out;
      });
      // Blank-entry: when upstream is 0-row and nothing pending, seed one
      // blank upsert row so the user has somewhere to type (Phase 3).
      if (seedBlank && this._state.upserts.length === 0) {
        const blank = {};
        for (const c of this._columns) blank[c.name] = '';
        this._state.upserts = [blank];
      }
      this._suppressChange = true;
      try { this._buildTable(); } finally { this._suppressChange = false; }
      if (this._popoverOpen) this._renderKeyPicker();
      setTimeout(() => this._onChange(), 0);
    }

    // Legacy hook (kept in case any external code still posts grid-rows).
    // Current path is grid-columns carrying both columns and rows.
    updateRows(rows) {
      if (!rows) return;
      this._upstreamByKey = {};
      for (const r of rows) {
        const v = r.values || r;
        const k = this._state.key_col ? v[this._state.key_col] : r.key;
        if (k != null) this._upstreamByKey[String(k)] = { ...v };
      }
      this._suppressChange = true;
      try {
        if (this._table) this._safeSetData(this._materializeRows());
        else if (this._columns.length > 0) this._buildTable();
      } finally { this._suppressChange = false; }
      setTimeout(() => this._onChange(), 0);
    }
  }

  // -------------------------------------------------------- Shiny binding

  const binding = new Shiny.InputBinding();
  Object.assign(binding, {
    find: (scope) => $(scope).find('.grid-block-container'),
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
      el._block = new GridBlock(el);
      if (el._pendingColumns) {
        const p = el._pendingColumns;
        el._block.updateColumns(p.columns, p.rows, p.seedBlank);
        delete el._pendingColumns;
      }
      if (el._pendingState) { el._block.setState(el._pendingState); delete el._pendingState; }
    },
    receiveMessage: (el, data) => {
      if (data.state) el._block?.setState(data.state);
    }
  });

  Shiny.inputBindings.register(binding, 'blockr.grid');

  Shiny.addCustomMessageHandler('grid-columns', (msg) => {
    const el = document.getElementById(msg.id);
    if (el?._block) el._block.updateColumns(msg.columns, msg.rows, msg.seed_blank);
    else if (el)    el._pendingColumns = {
      columns: msg.columns, rows: msg.rows, seedBlank: msg.seed_blank
    };
  });

  Shiny.addCustomMessageHandler('grid-block-update', (msg) => {
    const el = document.getElementById(msg.id);
    if (el?._block) el._block.setState(msg.state);
    else if (el)    el._pendingState = msg.state;
  });
})();
