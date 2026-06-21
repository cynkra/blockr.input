/**
 * TableBlock — server-paginated CRUD over an upstream table.
 *
 * No grid library. We render an HTML table for the current page slice
 * (received from R via `table-page` custom message), plus a pending-
 * changes strip above it that always shows accumulated upserts and
 * deletes regardless of which page is on screen.
 *
 * State JSON shape (round-trips with R):
 *   { key_col, upserts, deletes }   (same as new_grid_entry_block)
 *
 * View JSON shape (push-only to R, transient):
 *   { page, page_size, sort_col, sort_dir, search }
 *
 * Depends on: blockr-core.js (Blockr.icons + Blockr.Select).
 */
(() => {
  'use strict';

  let _clidCounter = 1;
  const newClid = () => `tb_${_clidCounter++}`;

  class TableBlock {
    constructor(el) {
      this.el = el;
      this._callback = null;

      // Persisted state
      this._state = { key_col: null, upserts: [], deletes: [] };
      // View state (push-only). pending_only filters the visible page
      // down to upstream rows whose key is in the pending set; null-keyed
      // inserts are appended JS-side. See SIZES.md TODO #5.
      this._view  = {
        page: 1,
        page_size: 5,
        sort_col: null,
        sort_dir: 'none',
        search: '',
        pending_only: false
      };

      // Transient
      this._columns = [];
      this._upstreamPage = [];
      this._totalRows = 0;
      this._maxPage = 1;
      this._popoverOpen = false;
      this._keySelect = null;
      this._searchDebounce = null;
      this._upserts_clid = new WeakMap(); // upsert obj → clid
      this._editingCell = null;           // {td, row, col, editor}
      this._page_selected = new Set();    // upstream keys selected on page

      this._buildShell();
      this._buildPopover();

      // Outside-click closes popover.
      document.addEventListener('click', (e) => {
        if (!this._popoverOpen) return;
        if (this.popover.contains(e.target) || this.gearBtn.contains(e.target)) return;
        this._closePopover();
      });

      // Paste handler (anywhere inside the block container).
      this.el.addEventListener('paste', (e) => this._onPaste(e));
    }

    // ---------------------------------------------------------------- DOM

    _buildShell() {
      this.card = document.createElement('div');
      this.card.className = 'tb-card';
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

      // Search bar + pending badge
      const searchWrap = document.createElement('div');
      searchWrap.className = 'tb-search-wrap';
      this.searchInput = document.createElement('input');
      this.searchInput.type = 'search';
      this.searchInput.className = 'tb-search-input';
      this.searchInput.placeholder = 'Search rows…';
      this.searchInput.addEventListener('input', () => {
        this._onSearchInput(this.searchInput.value);
      });
      searchWrap.appendChild(this.searchInput);

      // Pending badge: shows count of edits + acts as a filter toggle.
      // Position is fixed (next to search) — does NOT claim "above" /
      // "below" the page, because in a DB-backed table the rows have no
      // intrinsic position. See SIZES.md "M and XL fusion".
      this.pendingBadge = document.createElement('button');
      this.pendingBadge.type = 'button';
      this.pendingBadge.className = 'tb-pending-badge';
      this.pendingBadge.style.display = 'none';
      this.pendingBadge.addEventListener('click', () => this._togglePendingOnly());
      searchWrap.appendChild(this.pendingBadge);

      this.card.appendChild(searchWrap);

      // Page table
      this.pageWrap = document.createElement('div');
      this.pageWrap.className = 'tb-page-wrap';
      this.card.appendChild(this.pageWrap);

      // Footer (page nav)
      this.footer = document.createElement('div');
      this.footer.className = 'tb-footer';
      this.pageInfo = document.createElement('span');
      this.pageInfo.className = 'tb-page-info';
      this.pageInfo.textContent = '0 rows';
      this.footer.appendChild(this.pageInfo);

      this.prevBtn = document.createElement('button');
      this.prevBtn.type = 'button';
      this.prevBtn.className = 'tb-page-nav-btn';
      this.prevBtn.textContent = '‹';
      this.prevBtn.addEventListener('click', () => this._goToPage(this._view.page - 1));
      this.footer.appendChild(this.prevBtn);

      this.pageIndicator = document.createElement('span');
      this.pageIndicator.textContent = 'Page 1 / 1';
      this.footer.appendChild(this.pageIndicator);

      this.nextBtn = document.createElement('button');
      this.nextBtn.type = 'button';
      this.nextBtn.className = 'tb-page-nav-btn';
      this.nextBtn.textContent = '›';
      this.nextBtn.addEventListener('click', () => this._goToPage(this._view.page + 1));
      this.footer.appendChild(this.nextBtn);

      this.pageSizeSelect = document.createElement('select');
      this.pageSizeSelect.className = 'tb-page-size-select';
      ['5', '10', '25', '100'].forEach(n => {
        const opt = document.createElement('option');
        opt.value = n;
        opt.textContent = n + ' / page';
        this.pageSizeSelect.appendChild(opt);
      });
      this.pageSizeSelect.addEventListener('change', () => {
        this._view.page_size = parseInt(this.pageSizeSelect.value, 10) || 5;
        this._view.page = 1;
        this._pushView();
      });
      this.footer.appendChild(this.pageSizeSelect);

      this.card.appendChild(this.footer);

      // Action footer
      const actions = document.createElement('div');
      actions.className = 'tb-actions blockr-add-row';
      const leftActions = document.createElement('div');
      leftActions.className = 'tb-actions-left';
      actions.appendChild(leftActions);

      this.addBtn = document.createElement('span');
      this.addBtn.className = 'blockr-add-link';
      this.addBtn.innerHTML =
        `<span class="blockr-add-icon">${Blockr.icons.plus}</span> Add row`;
      this.addBtn.addEventListener('click', () => this._onAddRow());
      leftActions.appendChild(this.addBtn);

      this.delBtn = document.createElement('span');
      this.delBtn.className = 'blockr-add-link tb-delete-link tb-disabled';
      this.delBtn.innerHTML =
        `<span class="blockr-add-icon">${Blockr.icons.x}</span> Delete selected`;
      this.delBtn.addEventListener('click', () => {
        if (!this.delBtn.classList.contains('tb-disabled')) this._onDeleteSelected();
      });
      leftActions.appendChild(this.delBtn);

      this.statusEl = document.createElement('span');
      this.statusEl.className = 'tb-status';
      this.statusEl.textContent = 'ready';
      leftActions.appendChild(this.statusEl);

      this.card.appendChild(actions);
    }

    _buildPopover() {
      this.popover = document.createElement('div');
      this.popover.className = 'blockr-popover tb-popover';
      this.popover.style.display = 'none';
      const title = document.createElement('div');
      title.className = 'blockr-popover-title';
      title.textContent = 'Settings';
      this.popover.appendChild(title);

      const keyWrap = document.createElement('div');
      keyWrap.className = 'tb-popover-field';
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
          // Switching key invalidates pending diffs (their keys point at
          // the old column). Same UX as grid block.
          this._state.key_col = value || null;
          this._state.upserts = [];
          this._state.deletes = [];
          this._refreshAll();
          this._pushState(false);
        }
      });
    }

    // -------------------------------------------------------- View pushing

    _pushView() {
      if (typeof Shiny === 'undefined') return;
      // Container id ends in `-table_input`; the sibling input we want
      // to push to is `<ns>-table_view`. Strip the suffix and replace.
      const ns = this.el.id.replace(/-table_input$/, '');
      const payload = { ...this._view };
      // When pending-only is active, R needs the key + keys to do the
      // filter. Compute fresh — pending set may have changed since last push.
      if (this._view.pending_only) {
        payload.key_col      = this._state.key_col || '';
        payload.pending_keys = this._pendingKeys();
      } else {
        payload.key_col      = '';
        payload.pending_keys = [];
      }
      Shiny.setInputValue(ns + '-table_view', payload, {
        priority: 'event'
      });
    }

    _pushState() {
      // Trigger getValue via the binding's callback. Autocommit: every
      // valid edit flows; no Apply button (cell editor's Enter/blur is the
      // commit gesture).
      this._callback?.(true);
    }

    // -------------------------------------------------------- Pending filter

    // Union of upsert keys + delete keys, as strings (R-side `%in%` only
    // matches on type-aware comparison; we send strings and let dplyr's
    // coercion handle it).
    _pendingKeys() {
      const key = this._state.key_col;
      if (!key) return [];
      const out = new Set();
      (this._state.upserts || []).forEach(u => {
        const k = u[key];
        if (k != null && k !== '') out.add(String(k));
      });
      (this._state.deletes || []).forEach(k => {
        if (k != null && k !== '') out.add(String(k));
      });
      return Array.from(out);
    }

    // Null-keyed upserts (pure inserts) live only on JS. They have no
    // upstream row and so don't come back from R; render them inline at
    // the end of the page while in pending-only mode.
    _pendingInsertRows() {
      const key = this._state.key_col;
      if (!key) return [];
      return (this._state.upserts || []).filter(u => {
        const k = u[key];
        return k == null || k === '';
      });
    }

    _togglePendingOnly() {
      this._view.pending_only = !this._view.pending_only;
      this._view.page = 1;
      this._refreshPendingBadge();
      this._pushView();
    }

    _refreshPendingBadge() {
      const u = (this._state.upserts || []).length;
      const d = (this._state.deletes || []).length;
      const total = u + d;
      if (total === 0 && !this._view.pending_only) {
        this.pendingBadge.style.display = 'none';
        return;
      }
      this.pendingBadge.style.display = '';
      this.pendingBadge.classList.toggle('tb-pending-badge--active',
                                          this._view.pending_only);
      this.pendingBadge.textContent = this._view.pending_only
        ? `Showing ${total} pending ✕`
        : `${total} pending`;
      this.pendingBadge.title = this._view.pending_only
        ? 'Show all rows'
        : 'Show only pending edits';
    }

    _goToPage(p) {
      const next = Math.max(1, Math.min(this._maxPage, p));
      if (next === this._view.page) return;
      this._view.page = next;
      this._pushView();
    }

    _onSearchInput(value) {
      clearTimeout(this._searchDebounce);
      this._searchDebounce = setTimeout(() => {
        this._view.search = value;
        this._view.page = 1;
        this._pushView();
      }, 200);
    }

    _onSortHeader(col) {
      const order = ['none', 'asc', 'desc', 'na'];
      let dir = this._view.sort_col === col ? this._view.sort_dir : 'none';
      dir = order[(order.indexOf(dir) + 1) % order.length];
      this._view.sort_col = dir === 'none' ? null : col;
      this._view.sort_dir = dir;
      this._view.page = 1;
      this._pushView();
    }

    _sortIcon(col) {
      if (this._view.sort_col !== col || this._view.sort_dir === 'none') return '↕';
      if (this._view.sort_dir === 'asc')  return '↑';
      if (this._view.sort_dir === 'desc') return '↓';
      if (this._view.sort_dir === 'na')   return 'NA↑';
      return '';
    }

    _typeLabel(c) {
      // Mirror blockr.extra's type-label vocabulary: <int>, <dbl>, <chr>,
      // <date>, <fct>, <lgl>, <dttm>.
      const map = {
        int: '<int>', dbl: '<dbl>', chr: '<chr>',
        date: '<date>', factor: '<fct>', lgl: '<lgl>',
        datetime: '<dttm>'
      };
      return map[c.type] || `<${c.type}>`;
    }

    _buildHeaderCell(c) {
      const th = document.createElement('th');
      th.classList.add('tb-sortable');
      if (this._view.sort_col === c.name && this._view.sort_dir !== 'none') {
        th.classList.add('tb-sort-active');
      }
      const name = document.createElement('span');
      name.className = 'tb-col-name';
      name.textContent = c.label || c.name;
      const typeRow = document.createElement('span');
      typeRow.className = 'tb-type-row';
      const typeLabel = document.createElement('span');
      typeLabel.className = 'tb-type-label';
      typeLabel.textContent = this._typeLabel(c);
      const sortIcon = document.createElement('span');
      sortIcon.className = 'tb-sort-icon';
      sortIcon.textContent = this._sortIcon(c.name);
      typeRow.appendChild(typeLabel);
      typeRow.appendChild(sortIcon);
      th.appendChild(name);
      th.appendChild(typeRow);
      th.addEventListener('click', () => this._onSortHeader(c.name));
      return th;
    }

    _rowDiffersFromUpstream(row, upstream) {
      return this._columns.some(c =>
        this._normalizeForCompare(row[c.name]) !==
        this._normalizeForCompare(upstream[c.name])
      );
    }

    // ------------------------------------------------------ Page rendering

    _renderPage() {
      this.pageWrap.innerHTML = '';
      if (this._columns.length === 0) return;

      const tbl = document.createElement('table');
      tbl.className = 'blockr-input-table tb-page-table';

      const thead = document.createElement('thead');
      const trh = document.createElement('tr');

      // Row-number column header (empty)
      const thNum = document.createElement('th');
      thNum.className = 'tb-rownum-col';
      trh.appendChild(thNum);

      // Selection column header (master checkbox)
      const thSel = document.createElement('th');
      thSel.className = 'tb-select-col';
      const cbAll = document.createElement('input');
      cbAll.type = 'checkbox';
      cbAll.addEventListener('change', () => {
        this._page_selected.clear();
        if (cbAll.checked) {
          this._upstreamPage.forEach(r => {
            const k = this._state.key_col ? r[this._state.key_col] : null;
            if (k != null) this._page_selected.add(String(k));
          });
        }
        this._renderPage();
        this._refreshDeleteBtn();
      });
      thSel.appendChild(cbAll);
      trh.appendChild(thSel);

      this._columns.forEach(c => trh.appendChild(this._buildHeaderCell(c)));
      thead.appendChild(trh);
      tbl.appendChild(thead);

      const tbody = document.createElement('tbody');
      const key = this._state.key_col;
      const upsertByKey = {};
      (this._state.upserts || []).forEach(u => {
        const k = u[key]; if (k != null && k !== '') upsertByKey[String(k)] = u;
      });
      const deletedKeys = new Set((this._state.deletes || []).map(String));
      const startNum = (this._view.page - 1) * this._view.page_size + 1;

      this._upstreamPage.forEach((upstreamRow, idx) => {
        const tr = document.createElement('tr');
        const k = key ? upstreamRow[key] : null;
        const upsert = (k != null) ? upsertByKey[String(k)] : null;
        const isDeleted = (k != null) && deletedKeys.has(String(k));
        const rowData = upsert ?? upstreamRow;

        if (isDeleted) tr.classList.add('gb-row--deleted');
        else if (upsert && this._rowDiffersFromUpstream(upsert, upstreamRow)) {
          tr.classList.add('gb-row--updated');
        }

        // Row number
        const tdNum = document.createElement('td');
        tdNum.className = 'tb-rownum-col';
        tdNum.textContent = String(startNum + idx);
        tr.appendChild(tdNum);

        // Selection
        const tdSel = document.createElement('td');
        tdSel.className = 'tb-select-col';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = (k != null) && this._page_selected.has(String(k));
        cb.addEventListener('change', () => {
          if (k == null) return;
          if (cb.checked) this._page_selected.add(String(k));
          else            this._page_selected.delete(String(k));
          this._refreshDeleteBtn();
        });
        tdSel.appendChild(cb);
        tr.appendChild(tdSel);

        this._columns.forEach(c => {
          const td = document.createElement('td');
          const value = rowData[c.name];
          td.textContent = (value == null) ? '' : String(value);
          td.addEventListener('click', () => this._onCellClick(td, rowData, c, 'page', upstreamRow));
          tr.appendChild(td);
        });

        tbody.appendChild(tr);
      });

      // Pending-only mode: append null-keyed inserts at the end of the
      // page. They never appear in upstream so R doesn't send them; this
      // is where the user sees / edits them.
      if (this._view.pending_only) {
        const inserts = this._pendingInsertRows();
        inserts.forEach((insertRow, i) => {
          const tr = document.createElement('tr');
          tr.classList.add('gb-row--new');

          const tdNum = document.createElement('td');
          tdNum.className = 'tb-rownum-col';
          tdNum.textContent = '+';
          tr.appendChild(tdNum);

          const tdSel = document.createElement('td');
          tdSel.className = 'tb-select-col';
          // Inserts have no upstream key; can't select for upstream-key
          // deletion. Leave the cell blank.
          tr.appendChild(tdSel);

          this._columns.forEach(c => {
            const td = document.createElement('td');
            const value = insertRow[c.name];
            td.textContent = (value == null) ? '' : String(value);
            td.addEventListener('click',
              () => this._onCellClick(td, insertRow, c, 'insert'));
            tr.appendChild(td);
          });

          tbody.appendChild(tr);
        });
      }

      tbl.appendChild(tbody);
      this.pageWrap.appendChild(tbl);

      // Footer hidden in pending-only mode (all pending rows shown at once).
      if (this._view.pending_only) {
        this.footer.style.display = 'none';
      } else {
        this.footer.style.display = '';
        const start = (this._view.page - 1) * this._view.page_size + 1;
        const end   = Math.min(this._totalRows, this._view.page * this._view.page_size);
        this.pageInfo.textContent = this._totalRows > 0
          ? `${start}–${end} of ${this._totalRows}`
          : '0 rows';
        this.pageIndicator.textContent = `Page ${this._view.page} / ${this._maxPage}`;
        this.prevBtn.disabled = this._view.page <= 1;
        this.nextBtn.disabled = this._view.page >= this._maxPage;
        this.pageSizeSelect.value = String(this._view.page_size);
      }
    }

    // ----------------------------------------------------- Cell editing

    _onCellClick(td, rowData, col, source, upstreamRow) {
      // If we're already editing THIS cell, ignore: the click bubbled
      // up from the editor (e.g. clicking a <select> to open it).
      if (this._editingCell && this._editingCell.td === td) return;
      if (this._editingCell) this._commitEditor();
      this._beginEditor(td, rowData, col, source, upstreamRow);
    }

    _beginEditor(td, rowData, col, source, upstreamRow) {
      td.classList.add('tb-editing');
      td.innerHTML = '';
      const current = rowData[col.name];
      let editor;
      const finishOk = () => this._commitEditor();
      const cancel   = () => this._cancelEditor();

      switch (col.type) {
        case 'int':
        case 'dbl':
          // Use text + inputmode rather than type="number". type="number"
          // silently rejects non-digit keystrokes which feels broken
          // (e.g. typing 'a' appears to do nothing). Validation happens on
          // commit instead.
          editor = document.createElement('input');
          editor.type = 'text';
          editor.inputMode = (col.type === 'int') ? 'numeric' : 'decimal';
          editor.value = current == null ? '' : String(current);
          break;
        case 'date':
          editor = document.createElement('input');
          editor.type = 'date';
          editor.value = current == null ? '' : String(current);
          break;
        case 'lgl':
          editor = document.createElement('input');
          editor.type = 'checkbox';
          editor.checked = current === true || String(current).toLowerCase() === 'true';
          break;
        case 'factor': {
          // Use Blockr.Select for parity with the rest of the design
          // system (search-as-you-type, custom panel, blockr tokens).
          // Append the host to the td FIRST so the widget can compute
          // dropdown-panel positioning correctly at init time.
          const host = document.createElement('div');
          host.className = 'tb-select-host';
          td.innerHTML = '';
          td.appendChild(host);
          let picked = current == null ? '' : String(current);
          const sel = Blockr.Select.single(host, {
            options: (col.choices || []).map(v => ({ value: v, label: v })),
            selected: picked,
            placeholder: '',
            onChange: (v) => {
              picked = v;
              this._commitEditor();
            }
          });
          editor = host;
          Object.defineProperty(editor, 'value', { get: () => picked });
          editor.type = 'blockr-select';
          editor._blockrSelect = sel;
          break;
        }
        case 'chr':
        default:
          editor = document.createElement('input');
          editor.type = 'text';
          editor.value = current == null ? '' : String(current);
      }

      editor.addEventListener('keydown', (e) => {
        if (e.key === 'Enter')   { e.preventDefault(); finishOk(); }
        else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      });
      editor.addEventListener('blur', () => finishOk());
      // Native <select> and checkbox: commit on change so picking an
      // option / toggling the box commits without needing a separate blur.
      if (editor.tagName === 'SELECT' || editor.type === 'checkbox') {
        editor.addEventListener('change', () => finishOk());
      }

      td.appendChild(editor);
      editor.focus();
      if (editor.select) editor.select();

      this._editingCell = {
        td, rowData, col, source, upstreamRow, editor, originalValue: current
      };
    }

    _commitEditor() {
      const ec = this._editingCell;
      if (!ec) return;
      this._editingCell = null;
      const { td, rowData, col, source, upstreamRow, editor } = ec;
      let newValue;
      if (editor.type === 'checkbox') newValue = editor.checked;
      else newValue = editor.value;
      // Validate.
      if (!this._validateValue(newValue, col)) {
        td.classList.add('tb-invalid');
        td.classList.remove('tb-editing');
        td.textContent = String(newValue);
        this._refreshDeleteBtn();
        this._refreshStatus();
        return;
      }
      td.classList.remove('tb-invalid', 'tb-editing');
      td.textContent = (newValue == null) ? '' : String(newValue);
      // Apply the change to state.
      this._applyCellChange(rowData, col, newValue, source, upstreamRow);
      // Update only the row's diff class on the page table. Don't rebuild
      // the page DOM — the user's next click is queued against the live
      // nodes.
      const tr = td.closest('tr');
      if (tr && source === 'page') this._reclassifyPageRow(tr, upstreamRow);
      this._refreshPendingBadge();
      this._refreshDeleteBtn();
      this._refreshStatus();
    }

    _reclassifyPageRow(tr, upstreamRow) {
      tr.classList.remove('gb-row--new', 'gb-row--updated', 'gb-row--deleted');
      const key = this._state.key_col;
      if (!key) return;
      const k = upstreamRow[key];
      if (k == null) return;
      const ks = String(k);
      const deletedKeys = new Set((this._state.deletes || []).map(String));
      if (deletedKeys.has(ks)) { tr.classList.add('gb-row--deleted'); return; }
      const upsert = (this._state.upserts || []).find(u =>
        u[key] != null && String(u[key]) === ks);
      if (upsert && this._rowDiffersFromUpstream(upsert, upstreamRow)) {
        tr.classList.add('gb-row--updated');
      }
    }

    _cancelEditor() {
      const ec = this._editingCell;
      if (!ec) return;
      this._editingCell = null;
      ec.td.classList.remove('tb-editing', 'tb-invalid');
      const v = ec.originalValue;
      ec.td.textContent = (v == null) ? '' : String(v);
    }

    _validateValue(value, col) {
      if (value == null || value === '') return true; // NA-tolerant
      switch (col.type) {
        case 'int':
          return /^-?\d+$/.test(String(value));
        case 'dbl':
          return !isNaN(Number(value));
        case 'date':
          return /^\d{4}-\d{2}-\d{2}$/.test(String(value)) &&
                 !isNaN(new Date(value).getTime());
        case 'factor':
          return (col.choices || []).includes(String(value));
        default:
          return true;
      }
    }

    _applyCellChange(rowData, col, newValue, source, upstreamRow) {
      const key = this._state.key_col;

      if (source === 'page') {
        const k = key ? upstreamRow[key] : null;
        if (k == null) return; // no key on the upstream row, can't upsert
        // Find or create upsert for this key.
        let upsert = (this._state.upserts || []).find(u =>
          String(u[key]) === String(k));
        if (!upsert) {
          upsert = { ...upstreamRow };
          this._upserts_clid.set(upsert, newClid());
          this._state.upserts.push(upsert);
        }
        upsert[col.name] = this._coerceValueToType(newValue, col);
        // If the upsert now matches upstream exactly, remove it.
        if (!this._rowDiffersFromUpstream(upsert, upstreamRow)) {
          this._state.upserts = this._state.upserts.filter(u => u !== upsert);
        }
      } else {
        // 'insert' edit: rowData IS the (null-keyed) upsert. Mutate in place.
        rowData[col.name] = this._coerceValueToType(newValue, col);
      }

      this._pushState();

      // In pending-only mode, R-side filter set depends on state. Edits
      // that change the pending key set need a fresh page from R.
      if (this._view.pending_only) this._pushView();
    }

    _coerceValueToType(value, col) {
      if (value == null || value === '') return value;
      if (col.type === 'int') return parseInt(value, 10);
      if (col.type === 'dbl') return Number(value);
      if (col.type === 'lgl') return !!value;
      return String(value);
    }

    _normalizeForCompare(v) {
      if (v == null) return '';
      if (typeof v === 'string') return v;
      return String(v);
    }

    // -------------------------------------------------------- Add / Delete

    _onAddRow() {
      const key = this._state.key_col;
      const keyCol = key ? this._columns.find(c => c.name === key) : null;
      const seed = {};
      this._columns.forEach(c => { seed[c.name] = ''; });
      if (keyCol) seed[key] = this._suggestKeyValue(keyCol);
      this._upserts_clid.set(seed, newClid());
      this._state.upserts.push(seed);

      // Auto-switch to pending-only so the new row is immediately visible.
      // In normal browse mode a fresh insert with a suggested key would
      // most likely be off-page and invisible; pending-only puts it in
      // front of the user.
      if (!this._view.pending_only) {
        this._view.pending_only = true;
        this._view.page = 1;
        this._pushView();
      } else {
        // Already in pending mode: the new insert is JS-side, but the
        // pending key set may have changed (suggested key) so refresh.
        this._pushView();
      }
      this._refreshAll();
      this._pushState();
    }

    _suggestKeyValue(col) {
      if (col.type === 'int' || col.type === 'dbl') {
        let max = 0, found = false;
        // Try to use the visible page + pending upserts as a hint.
        this._upstreamPage.forEach(r => {
          const n = Number(r[col.name]);
          if (Number.isFinite(n)) { found = true; if (n > max) max = n; }
        });
        (this._state.upserts || []).forEach(u => {
          const n = Number(u[col.name]);
          if (Number.isFinite(n)) { found = true; if (n > max) max = n; }
        });
        if (!found) return 1;
        return col.type === 'int' ? Math.floor(max) + 1 : max + 1;
      }
      if (col.type === 'date') return new Date().toISOString().slice(0, 10);
      return '';
    }

    _onDeleteSelected() {
      const key = this._state.key_col;
      const deletes = new Set((this._state.deletes || []).map(String));

      // Page selections: toggle delete on upstream keys.
      this._page_selected.forEach(k => {
        if (deletes.has(k)) deletes.delete(k);
        else                deletes.add(k);
      });

      this._state.deletes = Array.from(deletes).map(s => {
        // Restore native type from the upstream sample if possible.
        const upstream = this._upstreamPageByKey()[s];
        return upstream ? upstream[key] : s;
      });
      this._page_selected.clear();
      this._refreshAll();
      this._pushState();
      if (this._view.pending_only) this._pushView();
    }

    _refreshDeleteBtn() {
      const enabled = this._page_selected.size > 0;
      this.delBtn.classList.toggle('tb-disabled', !enabled);
    }

    // -------------------------------------------------------- Paste

    _onPaste(e) {
      const text = (e.clipboardData || window.clipboardData)?.getData('text');
      if (!text) return;
      // Only handle if it looks like a multi-row TSV.
      if (!text.includes('\t') && !text.includes('\n')) return;
      e.preventDefault();
      const lines = text.split(/\r?\n/).filter(l => l.length > 0);
      const order = this._columns.map(c => c.name);
      const key = this._state.key_col;
      lines.forEach(line => {
        const cells = line.split('\t');
        const row = {};
        order.forEach((f, i) => { row[f] = cells[i] ?? ''; });
        if (key) {
          const cur = row[key];
          if (cur == null || cur === '') {
            const keyCol = this._columns.find(c => c.name === key);
            if (keyCol) row[key] = this._suggestKeyValue(keyCol);
          }
        }
        this._upserts_clid.set(row, newClid());
        this._state.upserts.push(row);
      });
      this._refreshAll();
      this._pushState();
      if (this._view.pending_only) this._pushView();
    }

    // -------------------------------------------------------- Helpers

    _upstreamPageByKey() {
      const out = {};
      const key = this._state.key_col;
      if (!key) return out;
      this._upstreamPage.forEach(r => {
        const k = r[key];
        if (k != null) out[String(k)] = r;
      });
      return out;
    }

    _refreshAll() {
      this._refreshDeleteBtn();
      this._refreshPendingBadge();
      this._renderPage();
      this._refreshStatus();
    }

    _refreshStatus() {
      const u = this._state.upserts.length;
      const d = this._state.deletes.length;
      const dirty = (u + d) > 0;
      const invalid = !!this.el.querySelector('.tb-invalid');
      const ok = !invalid && !!this._state.key_col;
      let msg;
      if (!this._state.key_col) msg = 'pick a key column';
      else if (invalid)         msg = 'invalid cell';
      else if (!dirty)          msg = `${this._totalRows} rows, no changes`;
      else                      msg = `${u} upsert(s), ${d} delete(s) live`;
      this.statusEl.textContent = msg;
      this.statusEl.className = 'tb-status ' + (ok ? 'tb-status--ok' : 'tb-status--err');
    }

    // -------------------------------------------------------- Public API

    getValue() {
      if (this.el.querySelector('.tb-invalid')) return null;
      if (!this._state.key_col) return null;
      return {
        key_col: this._state.key_col,
        upserts: this._state.upserts.map(u => {
          const out = { ...u };
          delete out._gb_deleted;
          delete out._gb_delete_key;
          return out;
        }),
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
      // Re-key clids
      this._upserts_clid = new WeakMap();
      this._state.upserts.forEach(u => this._upserts_clid.set(u, newClid()));
      if (this._popoverOpen) this._renderKeyPicker();
      this._refreshAll();
    }

    updatePage(payload) {
      if (payload.columns) {
        this._columns = payload.columns.slice();
        // Auto-pick key on first hydration.
        if (!this._state.key_col && this._columns.length > 0) {
          const pick = this._columns.find(c =>
            c.unique_count > 0 && c.unique_count === c.n_rows
          ) || this._columns[0];
          this._state.key_col = pick.name;
        }
      }
      if (payload.rows)        this._upstreamPage = payload.rows.slice();
      if (payload.total_rows != null) this._totalRows = payload.total_rows;
      if (payload.page != null)       this._view.page = payload.page;
      if (payload.page_size != null)  this._view.page_size = payload.page_size;
      if (payload.max_page != null)   this._maxPage = payload.max_page;
      this._refreshAll();
    }
  }

  // -------------------------------------------------------- Shiny binding

  const binding = new Shiny.InputBinding();
  Object.assign(binding, {
    find: (scope) => $(scope).find('.table-block-container'),
    getId: (el) => el.id || null,
    getValue: (el) => el._block?.getValue() ?? null,
    setValue: (el, value) => el._block?.setState(value),
    subscribe: (el, callback) => {
      if (el._block) el._block._callback = () => callback(true);
    },
    unsubscribe: (el) => { if (el._block) el._block._callback = null; },
    initialize: (el) => {
      el._block = new TableBlock(el);
      if (el._pendingPage)  { el._block.updatePage(el._pendingPage); delete el._pendingPage; }
      if (el._pendingState) { el._block.setState(el._pendingState); delete el._pendingState; }
    },
    receiveMessage: (el, data) => {
      if (data.state) el._block?.setState(data.state);
    }
  });

  Shiny.inputBindings.register(binding, 'blockr.table');

  Shiny.addCustomMessageHandler('table-page', (msg) => {
    const el = document.getElementById(msg.id);
    if (el?._block) el._block.updatePage(msg);
    else if (el)    el._pendingPage = msg;
  });

  Shiny.addCustomMessageHandler('table-block-update', (msg) => {
    const el = document.getElementById(msg.id);
    if (el?._block) el._block.setState(msg.state);
    else if (el)    el._pendingState = msg.state;
  });
})();
