/**
 * GridBlock — JS-driven multi-row data entry block (Tabulator-backed).
 *
 * Schema is the upstream tibble's column structure. The grid's rows ARE
 * the output: emit a tibble that replaces upstream's row set, with column
 * types preserved. Block holds (returns null) while any cell is invalid.
 *
 * Depends on: Tabulator (vendored under inst/js/vendor/tabulator/).
 */
(() => {
  'use strict';

  class GridBlock {
    constructor(el) {
      this.el = el;
      this._callback = null;
      this._submitted = false;

      // Persisted state (round-trips with R)
      this._state = { rows: [] };

      // Transient
      this._columns = [];      // [{name, type, choices?, unique_count, n_rows}]
      this._table = null;
      this._suppressChange = false;

      this._buildShell();
    }

    // ----------------------------------------------------------------- DOM

    _buildShell() {
      this.card = document.createElement('div');
      this.card.className = 'gb-card';
      this.el.appendChild(this.card);

      // Toolbar
      const tb = document.createElement('div');
      tb.className = 'gb-toolbar blockr-add-row';

      this.addBtn = document.createElement('button');
      this.addBtn.type = 'button';
      this.addBtn.className = 'blockr-add-link';
      this.addBtn.textContent = '+ Add row';
      this.addBtn.addEventListener('click', () => this._onAddRow());
      tb.appendChild(this.addBtn);

      this.delBtn = document.createElement('button');
      this.delBtn.type = 'button';
      this.delBtn.className = 'blockr-add-link gb-delete-btn';
      this.delBtn.textContent = 'Delete selected';
      this.delBtn.disabled = true;
      this.delBtn.addEventListener('click', () => this._onDeleteSelected());
      tb.appendChild(this.delBtn);

      this.statusEl = document.createElement('span');
      this.statusEl.className = 'gb-status';
      this.statusEl.textContent = 'ready';
      tb.appendChild(this.statusEl);

      this.card.appendChild(tb);

      // Grid host
      this.gridHost = document.createElement('div');
      this.gridHost.className = 'gb-host';
      this.card.appendChild(this.gridHost);
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
          return {
            ...base,
            editor: 'date',
            editorParams: { format: 'yyyy-MM-dd' },
            validator: [{
              type: function (cell, value) {
                if (value == null || value === '') return true; // NA-tolerant
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
          // No native datetime editor; fall back to text + ISO regex.
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
          // Choice via low-cardinality character: list editor with the
          // observed values; allow free entry too.
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

    _buildTable(seedRows) {
      if (this._table) {
        try { this._table.destroy(); } catch (_) {}
        this._table = null;
      }
      if (this._columns.length === 0) return;

      const cols = [
        { formatter: 'rowSelection', titleFormatter: 'rowSelection',
          hozAlign: 'center', headerSort: false, width: 30, frozen: true,
          clipboard: false }
      ].concat(this._columns.map(c => this._columnDef(c)));

      this._table = new Tabulator(this.gridHost, {
        data: seedRows ?? this._state.rows ?? [],
        columns: cols,
        layout: 'fitColumns',
        reactiveData: true,
        selectableRows: true,
        clipboard: true,
        clipboardPasteAction: 'replace',
        clipboardPasteParser: c => this._tsvParser(c),
        clipboardCopyRowRange: 'selected',
        clipboardCopyConfig: { columnHeaders: false },
        validationMode: 'highlight',
        placeholder: 'Empty',
        height: '320px'
      });

      const onChange = () => this._onChange();
      ['cellEdited', 'rowAdded', 'rowDeleted',
       'dataChanged', 'dataLoaded', 'clipboardPasted']
        .forEach(ev => this._table.on(ev, onChange));
      this._table.on('rowSelectionChanged', () => this._refreshDeleteBtn());
      this._table.on('tableBuilt', onChange);

      if (seedRows) this._state.rows = seedRows;
    }

    _onChange() {
      if (!this._table) return;
      if (this._suppressChange) return;
      this._table.validate();
      const data = this._table.getData();
      const errors = this._table.getInvalidCells();
      const ok = errors.length === 0;
      this._state.rows = data;
      this._submitted = ok;
      this._setStatus(
        ok ? `${data.length} rows, all valid`
           : `${errors.length} invalid cell(s)`,
        ok
      );
      this._callback?.(true);
    }

    _setStatus(msg, ok) {
      this.statusEl.textContent = msg;
      this.statusEl.className = 'gb-status ' + (ok ? 'gb-status--ok' : 'gb-status--err');
    }

    _refreshDeleteBtn() {
      if (!this._table) { this.delBtn.disabled = true; return; }
      const sel = this._table.getSelectedRows();
      this.delBtn.disabled = !sel || sel.length === 0;
    }

    _onAddRow() {
      if (!this._table) return;
      this._table.addRow({}).catch(() => {});
    }

    _onDeleteSelected() {
      if (!this._table) return;
      const sel = this._table.getSelectedRows();
      sel.forEach(r => r.delete());
      this._refreshDeleteBtn();
      this._onChange();
    }

    // -------------------------------------------------------- Public API

    getValue() {
      if (!this._submitted) return null;
      return this._state;
    }

    setState(state) {
      const next = { rows: ((state && state.rows) || []).slice() };
      this._state = next;
      this._suppressChange = true;
      try {
        if (this._table) {
          this._table.setData(next.rows).catch(() => {});
        }
      } finally {
        this._suppressChange = false;
      }
      // Re-validate / re-emit after the new data settles.
      setTimeout(() => this._onChange(), 0);
    }

    updateColumns(cols, seedRows) {
      this._columns = (cols || []).slice();
      // Drop fields from existing rows that are no longer in the schema.
      const colSet = new Set(this._columns.map(c => c.name));
      this._state.rows = (this._state.rows || []).map(r => {
        const out = {};
        for (const k of Object.keys(r)) if (colSet.has(k)) out[k] = r[k];
        return out;
      });
      // seedRows arrives only when state was empty (first hydration);
      // if the user has been editing, R sends seed = null and we keep rows.
      this._suppressChange = true;
      try {
        this._buildTable(seedRows ?? null);
      } finally {
        this._suppressChange = false;
      }
      // Trigger a re-validation pass after the table settles.
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
        el._block.updateColumns(el._pendingColumns.cols, el._pendingColumns.seed);
        delete el._pendingColumns;
      }
      if (el._pendingState) {
        el._block.setState(el._pendingState);
        delete el._pendingState;
      }
    },
    receiveMessage: (el, data) => {
      if (data.state) el._block?.setState(data.state);
    }
  });

  Shiny.inputBindings.register(binding, 'blockr.grid');

  Shiny.addCustomMessageHandler('grid-columns', (msg) => {
    const el = document.getElementById(msg.id);
    const payload = { cols: msg.columns, seed: msg.seed_rows };
    if (el?._block) el._block.updateColumns(payload.cols, payload.seed);
    else if (el)    el._pendingColumns = payload;
  });

  Shiny.addCustomMessageHandler('grid-block-update', (msg) => {
    const el = document.getElementById(msg.id);
    if (el?._block) el._block.setState(msg.state);
    else if (el)    el._pendingState = msg.state;
  });
})();
