/**
 * TableBlock — server-paginated CRUD over an upstream table.
 *
 * No grid library. We render an HTML table for the current page slice
 * (received from R via `table-page` custom message), plus a pending-
 * changes strip above it that always shows accumulated upserts and
 * deletes regardless of which page is on screen.
 *
 * State JSON shape (round-trips with R):
 *   { key_col, upserts, deletes }   (same as new_grid_block)
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
      this._submitted = false;

      // Persisted state
      this._state = { key_col: null, upserts: [], deletes: [] };
      // View state (push-only)
      this._view  = {
        page: 1,
        page_size: 5,
        sort_col: null,
        sort_dir: 'none',
        search: ''
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
      this._strip_selected = new Set();   // clids of strip rows selected
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

      // Pending strip
      this.stripWrap = document.createElement('div');
      this.stripWrap.className = 'tb-strip-wrap';
      const stripLabel = document.createElement('div');
      stripLabel.className = 'tb-strip-label';
      this.stripLabel = stripLabel;
      this.stripWrap.appendChild(stripLabel);
      this.stripScroll = document.createElement('div');
      this.stripScroll.className = 'tb-strip-scroll';
      this.stripWrap.appendChild(this.stripScroll);
      this.card.appendChild(this.stripWrap);

      // Search bar
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

      this.applyBtn = document.createElement('button');
      this.applyBtn.type = 'button';
      this.applyBtn.className = 'blockr-pill tb-apply-btn';
      this.applyBtn.textContent = 'Apply';
      this.applyBtn.disabled = true;
      this.applyBtn.addEventListener('click', () => this._onApply());
      actions.appendChild(this.applyBtn);

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
      Shiny.setInputValue(ns + '-table_view', this._view, {
        priority: 'event'
      });
    }

    _pushState(submitted) {
      this._submitted = !!submitted || this._submitted;
      // Trigger getValue via the binding's callback.
      this._callback?.(true);
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
      name.textContent = c.name;
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

    // ----------------------------------------------------- Strip rendering

    _renderStrip() {
      this.stripScroll.innerHTML = '';
      const upserts = this._state.upserts || [];
      const deletes = this._state.deletes || [];
      const totalPending = upserts.length + deletes.length;
      this.stripLabel.textContent =
        totalPending === 0 ? 'Pending changes (0)'
                           : `Pending changes (${upserts.length} upsert${upserts.length===1?'':'s'}, ${deletes.length} delete${deletes.length===1?'':'s'})`;

      if (totalPending === 0) {
        const empty = document.createElement('div');
        empty.className = 'tb-strip-empty';
        empty.textContent = 'No pending changes. Edit a row or click "+ Add row" to begin.';
        this.stripScroll.appendChild(empty);
        return;
      }

      const tbl = document.createElement('table');
      tbl.className = 'blockr-input-table';

      const thead = document.createElement('thead');
      const trh = document.createElement('tr');
      // Selection column
      const thSel = document.createElement('th');
      thSel.className = 'tb-select-col';
      thSel.textContent = '';
      trh.appendChild(thSel);
      this._columns.forEach(c => {
        const th = document.createElement('th');
        th.textContent = c.name;
        trh.appendChild(th);
      });
      thead.appendChild(trh);
      tbl.appendChild(thead);

      const tbody = document.createElement('tbody');
      // Upserts first, then deletes.
      upserts.forEach(u => {
        const tr = this._buildStripRow(u, 'upsert');
        tbody.appendChild(tr);
      });
      deletes.forEach(k => {
        const upstreamRow = this._upstreamPageByKey()[String(k)] || { [this._state.key_col]: k };
        const tr = this._buildStripRow(
          { ...upstreamRow, _gb_deleted: true, _gb_delete_key: k },
          'delete'
        );
        tbody.appendChild(tr);
      });
      tbl.appendChild(tbody);
      this.stripScroll.appendChild(tbl);
    }

    _buildStripRow(row, kind) {
      const tr = document.createElement('tr');
      tr.dataset.kind = kind;
      // Classify
      const key = this._state.key_col;
      if (kind === 'delete') {
        tr.classList.add('gb-row--deleted');
      } else {
        const k = row[key];
        const upstream = (k != null && k !== '')
          ? this._upstreamAllKnownByKey()[String(k)]
          : null;
        if (!upstream || k == null || k === '') tr.classList.add('gb-row--new');
        else if (this._rowDiffersFromUpstream(row, upstream)) tr.classList.add('gb-row--updated');
      }

      // Selection cell
      const tdSel = document.createElement('td');
      tdSel.className = 'tb-select-col';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      const clid = this._upserts_clid.get(row) ||
                   (kind === 'delete' ? `del_${row._gb_delete_key}` : null);
      cb.checked = clid && this._strip_selected.has(clid);
      cb.addEventListener('change', () => {
        if (cb.checked) this._strip_selected.add(clid);
        else            this._strip_selected.delete(clid);
        this._refreshDeleteBtn();
      });
      tdSel.appendChild(cb);
      tr.appendChild(tdSel);

      // Cells
      this._columns.forEach(c => {
        const td = document.createElement('td');
        const value = row[c.name];
        td.textContent = (value == null || value === '') ? '' : String(value);
        if (kind !== 'delete') {
          td.addEventListener('click', () => this._onCellClick(td, row, c, 'strip'));
        }
        tr.appendChild(td);
      });

      return tr;
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
      tbl.appendChild(tbody);
      this.pageWrap.appendChild(tbl);

      // Footer info
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
        this._refreshStatusAndApply();
        return;
      }
      td.classList.remove('tb-invalid', 'tb-editing');
      td.textContent = (newValue == null) ? '' : String(newValue);
      // Apply the change to state.
      this._applyCellChange(rowData, col, newValue, source, upstreamRow);
      // Update only the row's diff class on the page table; rebuild the
      // strip (count / new entries change). Don't rebuild the page DOM,
      // because the user's next click is queued against the live nodes.
      const tr = td.closest('tr');
      if (tr && source === 'page') this._reclassifyPageRow(tr, upstreamRow);
      this._renderStrip();
      this._refreshStatusAndApply();
    }

    _refreshStatusAndApply() {
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
        // Strip edit: rowData IS the upsert object.
        rowData[col.name] = this._coerceValueToType(newValue, col);
      }

      // Don't flip _submitted here — only Apply does that. After first
      // Apply, _submitted stays true and edits stream automatically.
      this._pushState(false);
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
      this._submitted = this._submitted || false; // not yet valid until cells fill
      this._refreshAll();
      this._pushState(false);
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
      // Strip selections: undelete pending-deletes, drop pending upserts.
      const keepUpserts = [];
      const stripSel = this._strip_selected;
      const deletes = new Set((this._state.deletes || []).map(String));
      (this._state.upserts || []).forEach(u => {
        const clid = this._upserts_clid.get(u);
        if (clid && stripSel.has(clid)) {
          // Drop this upsert.
        } else {
          keepUpserts.push(u);
        }
      });
      // Delete-marked rows in the strip → toggle off (undelete)
      stripSel.forEach(id => {
        if (id && id.startsWith('del_')) {
          const k = id.slice(4);
          deletes.delete(k);
        }
      });

      // Page selections: toggle delete on upstream keys.
      this._page_selected.forEach(k => {
        if (deletes.has(k)) deletes.delete(k);
        else                deletes.add(k);
      });

      this._state.upserts = keepUpserts;
      this._state.deletes = Array.from(deletes).map(s => {
        // Restore native type from the upstream sample if possible.
        const upstream = this._upstreamPageByKey()[s];
        return upstream ? upstream[key] : s;
      });
      this._strip_selected.clear();
      this._page_selected.clear();
      this._refreshAll();
      this._pushState(false);
    }

    _refreshDeleteBtn() {
      const enabled = this._strip_selected.size + this._page_selected.size > 0;
      this.delBtn.classList.toggle('tb-disabled', !enabled);
    }

    // -------------------------------------------------------- Apply

    _onApply() {
      // Validate via the existing cell-state.
      // We don't track invalid cells globally; assume valid if no
      // tb-invalid classes are present.
      if (this.el.querySelector('.tb-invalid')) return;
      if (!this._state.key_col) return;
      this._submitted = true;
      this.applyBtn.disabled = true;
      this._pushState(true);
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
      this._pushState(false);
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

    // Combines current page + any cached upstream rows we know about.
    // For diff-classification of the strip when a row is from a
    // different page we don't have its full upstream row available; we
    // fall back to the strip row's own values, which means "updated"
    // detection only works on the current page. That's fine for v1.
    _upstreamAllKnownByKey() {
      return this._upstreamPageByKey();
    }

    _refreshAll() {
      this._refreshDeleteBtn();
      this._renderStrip();
      this._renderPage();
      this._refreshStatus();
    }

    _refreshStatus() {
      const u = this._state.upserts.length;
      const d = this._state.deletes.length;
      const dirty = (u + d) > 0;
      const invalid = !!this.el.querySelector('.tb-invalid');
      const ok = !invalid && !!this._state.key_col;
      this.applyBtn.disabled = !(ok && dirty);
      let msg;
      if (!this._state.key_col) msg = 'pick a key column';
      else if (invalid)         msg = 'invalid cell';
      else if (!dirty)          msg = `${this._totalRows} rows, no changes`;
      else if (this._submitted) msg = `${u} upsert(s), ${d} delete(s) live`;
      else                      msg = `${u} upsert(s), ${d} delete(s) — click Apply`;
      this.statusEl.textContent = msg;
      this.statusEl.className = 'tb-status ' + (ok ? 'tb-status--ok' : 'tb-status--err');
    }

    // -------------------------------------------------------- Public API

    getValue() {
      if (!this._submitted) return null;
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
