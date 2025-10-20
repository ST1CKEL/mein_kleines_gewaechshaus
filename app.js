const STORAGE_KEY = "greenhouse-log";
const ENTRY_STORAGE_KEY = `${STORAGE_KEY}-entries`;
const DB_NAME = "GreenhouseLogDB";
const DB_VERSION = 1;
const DB_STORE_NAME = "entries";

const repeatingSections = [
    {
        key: "irrigation",
        body: document.getElementById("irrigation-body"),
        template: document.getElementById("irrigation-row-template"),
        minRows: 1
    },
    {
        key: "nutrient",
        body: document.getElementById("nutrient-body"),
        template: document.getElementById("nutrient-row-template"),
        minRows: 1
    },
    {
        key: "pest",
        body: document.getElementById("pest-body"),
        template: document.getElementById("pest-row-template"),
        minRows: 1
    },
    {
        key: "incident",
        body: document.getElementById("incident-body"),
        template: document.getElementById("incident-row-template"),
        minRows: 1
    }
];

const form = document.getElementById("greenhouse-log");
const buttons = {
    saveEntry: document.getElementById("save-entry"),
    loadSample: document.getElementById("load-sample"),
    saveLocal: document.getElementById("save-local"),
    loadLocal: document.getElementById("load-local"),
    exportJson: document.getElementById("export-json"),
    print: document.getElementById("print-log")
};

const statusHost = createStatusHost();
let suppressResetHandling = false;
let logDatabase = null;
let cachedEntries = [];

const historyBody = document.getElementById("history-body");
const historyEmpty = document.getElementById("history-empty");
const statisticsContent = document.getElementById("statistics-content");
const trendContent = document.getElementById("trend-content");

let currentEditingEntryId = null;
let currentEditingCreatedAt = null;

const TREND_FIELDS = [
    { key: "climate_inside_temp_min", unit: "C" },
    { key: "climate_inside_temp_max", unit: "C" },
    { key: "climate_inside_temp_avg", unit: "C" },
    { key: "climate_outside_temp_min", unit: "C" },
    { key: "climate_outside_temp_max", unit: "C" },
    { key: "climate_outside_temp_avg", unit: "C" },
    { key: "climate_rh_min", unit: "%" },
    { key: "climate_rh_max", unit: "%" },
    { key: "climate_rh_avg", unit: "%" },
    { key: "climate_dewpoint_min", unit: "C" },
    { key: "climate_dewpoint_max", unit: "C" },
    { key: "climate_dewpoint_avg", unit: "C" },
    { key: "climate_vpd_min", unit: "kPa" },
    { key: "climate_vpd_max", unit: "kPa" },
    { key: "climate_vpd_avg", unit: "kPa" },
    { key: "climate_co2_min", unit: "ppm" },
    { key: "climate_co2_max", unit: "ppm" },
    { key: "climate_co2_avg", unit: "ppm" },
    { key: "climate_co21000_duration", unit: "min" },
    { key: "light_dli_value", unit: "mol m-2 d-1" },
    { key: "light_ppfd_value", unit: "umol m-2 s-1" },
    { key: "light_hours_value", unit: "h" },
    { key: "light_outage_count", unit: "#" },
    { key: "pest_traps_count", unit: "#" }
];

function init() {
    repeatingSections.forEach(section => ensureMinimumRows(section));

    form.addEventListener("click", handleFormClick);
    form.addEventListener("reset", handleFormReset);

    if (buttons.saveEntry) {
        buttons.saveEntry.addEventListener("click", handleSaveEntry);
    }
    buttons.loadSample.addEventListener("click", handleLoadSample);
    buttons.saveLocal.addEventListener("click", handleSaveLocal);
    buttons.loadLocal.addEventListener("click", handleLoadLocal);
    buttons.exportJson.addEventListener("click", handleExportJson);
    buttons.print.addEventListener("click", () => window.print());

    if (historyBody) {
        historyBody.addEventListener("click", handleHistoryClick);
    }

    updateSaveEntryLabel();

    // Try to restore the latest draft silently.
    tryAutoRestore();

    setupDatabase();
}

function handleFormClick(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
        return;
    }

    const action = target.dataset.action;
    if (!action) {
        return;
    }

    if (action.startsWith("add-")) {
        const key = action.replace("add-", "");
        const section = repeatingSections.find(item => item.key === key);
        if (section) {
            addRow(section);
            announce(`Neue Zeile fuer ${labelForKey(key)} eingefuegt.`);
        }
    } else if (action === "remove-row") {
        const row = target.closest("tr");
        if (!row) {
            return;
        }
        const section = findSectionForRow(row);
        if (!section) {
            row.remove();
            return;
        }
        if (section.body.querySelectorAll("tr").length <= section.minRows) {
            announce("Mindestens eine Zeile muss erhalten bleiben.");
            return;
        }
        row.remove();
        announce("Zeile entfernt.");
    }
}

function handleFormReset() {
    if (suppressResetHandling) {
        suppressResetHandling = false;
        return;
    }
    setEditingEntry(null);
    highlightHistoryRow(null);
    window.setTimeout(() => {
        repeatingSections.forEach(section => {
            clearRows(section);
            ensureMinimumRows(section);
        });
        announce("Formular zurueckgesetzt.");
    }, 0);
}

function handleLoadSample() {
    const template = document.getElementById("sample-data");
    if (!template) {
        announce("Keine Musterdaten gefunden.", "error");
        return;
    }

    setEditingEntry(null);
    highlightHistoryRow(null);

    try {
        const payload = JSON.parse(template.innerHTML);
        populateForm(payload);
        announce("Musterdaten geladen.");
    } catch (error) {
        console.error(error);
        announce("Musterdaten konnten nicht geladen werden.", "error");
    }
}

async function handleSaveEntry() {
    if (!logDatabase) {
        announce("Datenbank nicht bereit.", "error");
        return;
    }

    const payload = serializeForm();
    if (!payload.meta_date) {
        announce("Bitte Datum eintragen, bevor der Eintrag gespeichert wird.", "error");
        return;
    }

    const now = new Date().toISOString();
    const isUpdate = Boolean(currentEditingEntryId);
    const entryId = currentEditingEntryId || createEntryId(payload.meta_date);
    const createdAt = currentEditingCreatedAt || now;
    const entry = {
        id: entryId,
        createdAt,
        updatedAt: now,
        data: payload,
        meta: {
            date: payload.meta_date || "",
            zone: payload.meta_zone || "",
            responsible: payload.meta_responsible || "",
            shift: payload.meta_shift || "",
            createdAt,
            updatedAt: now
        }
    };

    try {
        await logDatabase.save(entry);
        await refreshHistory();
        const savedEntry = cachedEntries.find(item => item.id === entry.id) || entry;
        setEditingEntry(savedEntry);
        highlightHistoryRow(savedEntry.id);
        announce(isUpdate ? "Eintrag aktualisiert." : "Eintrag gespeichert.");
    } catch (error) {
        console.error("Speichern fehlgeschlagen:", error);
        announce("Eintrag konnte nicht gespeichert werden.", "error");
    }
}

function handleSaveLocal() {
    const payload = serializeForm();
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
        announce("Entwurf lokal gespeichert.");
    } catch (error) {
        console.error(error);
        announce("Speichern fehlgeschlagen. Bitte Browser-Einstellungen pruefen.", "error");
    }
}

function handleLoadLocal() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) {
            announce("Keine gespeicherten Daten gefunden.", "error");
            return;
        }
        const payload = JSON.parse(raw);
        setEditingEntry(null);
        highlightHistoryRow(null);
        populateForm(payload);
        announce("Gespeicherte Daten geladen.");
    } catch (error) {
        console.error(error);
        announce("Daten konnten nicht geladen werden.", "error");
    }
}

function handleExportJson() {
    const payload = serializeForm();
    const fileName = buildFileName(payload.meta_date);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    announce(`Export als ${fileName}.`);
}

async function handleHistoryClick(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
        return;
    }

    const button = target.closest("button[data-action]");
    if (!button) {
        return;
    }

    const entryId = button.dataset.entryId;
    if (!entryId) {
        return;
    }

    if (button.dataset.action === "load-entry") {
        await loadEntryById(entryId);
    } else if (button.dataset.action === "delete-entry") {
        await deleteEntryById(entryId);
    }
}

async function loadEntryById(entryId) {
    if (!logDatabase) {
        announce("Datenbank nicht bereit.", "error");
        return;
    }

    try {
        const entry = await logDatabase.get(entryId);
        if (!entry) {
            announce("Eintrag nicht gefunden.", "error");
            return;
        }
        populateForm(entry.data);
        setEditingEntry(entry);
        highlightHistoryRow(entryId);
        announce(`Eintrag vom ${entry.meta?.date || "Unbekannt"} zur Bearbeitung geladen.`);
        window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (error) {
        console.error("Eintrag konnte nicht geladen werden:", error);
        announce("Eintrag konnte nicht geladen werden.", "error");
    }
}

async function deleteEntryById(entryId) {
    if (!logDatabase) {
        announce("Datenbank nicht bereit.", "error");
        return;
    }

    const entry = cachedEntries.find(item => item.id === entryId) || (await logDatabase.get(entryId));
    const formattedDate = entry?.meta?.date ? formatDate(entry.meta.date) : "";
    const label = formattedDate || entry?.meta?.zone || "";
    const question = label
        ? `Eintrag ${formattedDate ? `vom ${formattedDate}` : `(${label})`} wirklich loeschen?`
        : "Eintrag wirklich loeschen?";

    if (!window.confirm(question)) {
        return;
    }

    try {
        await logDatabase.delete(entryId);
        if (currentEditingEntryId === entryId) {
            setEditingEntry(null);
            highlightHistoryRow(null);
        }
        await refreshHistory();
        highlightHistoryRow(null);
        const successLabel = formattedDate ? `Eintrag vom ${formattedDate}` : "Eintrag";
        announce(`${successLabel} geloescht.`);
    } catch (error) {
        console.error("Eintrag konnte nicht geloescht werden:", error);
        announce("Eintrag konnte nicht geloescht werden.", "error");
    }
}

function highlightHistoryRow(entryId) {
    if (!historyBody) {
        return;
    }
    historyBody.querySelectorAll("tr").forEach(row => {
        if (row.dataset.entryId === entryId) {
            row.classList.add("active");
        } else {
            row.classList.remove("active");
        }
    });
}

function setEditingEntry(entry) {
    if (entry && entry.id) {
        currentEditingEntryId = entry.id;
        currentEditingCreatedAt = entry.createdAt || entry.meta?.createdAt || null;
    } else {
        currentEditingEntryId = null;
        currentEditingCreatedAt = null;
    }
    updateSaveEntryLabel();
}

function updateSaveEntryLabel() {
    if (!buttons.saveEntry) {
        return;
    }
    if (currentEditingEntryId) {
        buttons.saveEntry.textContent = "Eintrag aktualisieren";
        buttons.saveEntry.dataset.mode = "edit";
    } else {
        buttons.saveEntry.textContent = "Eintrag speichern";
        buttons.saveEntry.dataset.mode = "new";
    }
}

function tryAutoRestore() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) {
            return;
        }
        const payload = JSON.parse(raw);
        populateForm(payload);
        setEditingEntry(null);
        highlightHistoryRow(null);
        announce("Automatisch wiederhergestellt (lokaler Speicher).");
    } catch (error) {
        console.warn("Automatische Wiederherstellung nicht moeglich.", error);
    }
}

function serializeForm() {
    const data = {};
    const formData = new FormData(form);

    for (const [name, value] of formData.entries()) {
        if (name.endsWith("[]")) {
            continue; // handled separately
        }
        if (data[name] !== undefined) {
            if (!Array.isArray(data[name])) {
                data[name] = [data[name]];
            }
            data[name].push(value);
        } else {
            data[name] = value;
        }
    }

    form.querySelectorAll('input[type="checkbox"]').forEach(checkbox => {
        data[checkbox.name] = checkbox.checked;
    });

    repeatingSections.forEach(section => {
        data[section.key] = sectionToArray(section);
    });

    return data;
}

function populateForm(payload) {
    suppressResetHandling = true;
    form.reset();
    repeatingSections.forEach(section => {
        clearRows(section);
        ensureMinimumRows(section);
    });

    Object.entries(payload || {}).forEach(([name, value]) => {
        const section = repeatingSections.find(item => item.key === name);
        if (section) {
            populateSection(section, Array.isArray(value) ? value : []);
            return;
        }

        const control = form.elements.namedItem(name);
        if (!control) {
            return;
        }

        if (control instanceof RadioNodeList) {
            if (Array.isArray(value)) {
                value = value[0];
            }
            control.value = value;
            return;
        }

        if (control.type === "checkbox") {
            control.checked = Boolean(value);
        } else {
            control.value = value;
        }
    });
}

function sectionToArray(section) {
    const rows = [];
    section.body.querySelectorAll("tr").forEach(row => {
        const record = {};
        row.querySelectorAll("input, select, textarea").forEach(field => {
            const baseName = field.name.replace(/\[\]$/, "");
            if (!baseName) {
                return;
            }
            if (field.type === "checkbox") {
                record[baseName] = field.checked;
            } else {
                record[baseName] = field.value;
            }
        });
        if (Object.values(record).some(value => value !== "")) {
            rows.push(record);
        }
    });
    return rows;
}

function populateSection(section, values) {
    clearRows(section);
    if (!values.length) {
        ensureMinimumRows(section);
        return;
    }
    values.forEach(record => {
        const row = addRow(section);
        row.querySelectorAll("input, select, textarea").forEach(field => {
            const baseName = field.name.replace(/\[\]$/, "");
            if (!(baseName in record)) {
                return;
            }
            if (field.type === "checkbox") {
                field.checked = Boolean(record[baseName]);
            } else {
                field.value = record[baseName];
            }
        });
    });
}

function ensureMinimumRows(section) {
    const current = section.body.querySelectorAll("tr").length;
    const required = section.minRows - current;
    for (let i = 0; i < required; i += 1) {
        addRow(section);
    }
}

function addRow(section) {
    const fragment = section.template.content.cloneNode(true);
    const row = fragment.querySelector("tr");
    if (!row) {
        throw new Error(`Template ${section.template.id} enthaelt keine Tabellenzeile.`);
    }
    section.body.appendChild(fragment);
    return section.body.lastElementChild;
}

function clearRows(section) {
    section.body.innerHTML = "";
}

function findSectionForRow(row) {
    return repeatingSections.find(section => section.body.contains(row));
}

function buildFileName(dateValue) {
    if (dateValue) {
        return `tagesprotokoll-${dateValue}.json`;
    }
    const stamp = new Date().toISOString().slice(0, 10);
    return `tagesprotokoll-${stamp}.json`;
}

function labelForKey(key) {
    switch (key) {
        case "irrigation":
            return "Bewaesserung & Substrat";
        case "nutrient":
            return "Naehrloesung";
        case "pest":
            return "Schaedlingsmonitoring";
        case "incident":
            return "Alarme & Ereignisse";
        default:
            return key;
    }
}

async function setupDatabase() {
    try {
        logDatabase = createDatabase();
        if (typeof logDatabase.ready === "function") {
            await logDatabase.ready();
        } else if (logDatabase && logDatabase.dbPromise instanceof Promise) {
            await logDatabase.dbPromise;
        }
        await refreshHistory();
    } catch (error) {
        console.error("Initialisierung der Datenbank fehlgeschlagen:", error);
        announce("Datenbank konnte nicht initialisiert werden.", "error");
    }
}

async function refreshHistory() {
    if (!logDatabase) {
        return;
    }
    try {
        const entries = await logDatabase.getAll();
        cachedEntries = Array.isArray(entries) ? entries.slice() : [];
        cachedEntries.sort((a, b) => {
            const aTime = a.updatedAt || a.meta?.updatedAt || a.createdAt || "";
            const bTime = b.updatedAt || b.meta?.updatedAt || b.createdAt || "";
            return bTime.localeCompare(aTime);
        });
        renderHistory(cachedEntries);
        renderStatistics(cachedEntries);
        renderTrends(cachedEntries);
    } catch (error) {
        console.error("Historie konnte nicht geladen werden:", error);
        announce("Historie konnte nicht geladen werden.", "error");
    }
}

function renderHistory(entries) {
    if (!historyBody || !historyEmpty) {
        return;
    }

    historyBody.innerHTML = "";

    if (!entries.length) {
        historyEmpty.hidden = false;
        return;
    }

    historyEmpty.hidden = true;

    entries.forEach(entry => {
        const row = document.createElement("tr");
        row.dataset.entryId = entry.id;

        const dateCell = document.createElement("td");
        dateCell.textContent = formatDate(entry.meta?.date) || "-";

        const zoneCell = document.createElement("td");
        zoneCell.textContent = entry.meta?.zone || "-";

        const responsibleCell = document.createElement("td");
        responsibleCell.textContent = entry.meta?.responsible || "-";

        const createdCell = document.createElement("td");
        const timestamp = entry.updatedAt || entry.meta?.updatedAt || entry.createdAt;
        createdCell.textContent = formatTimestamp(timestamp);
        if (entry.updatedAt && entry.createdAt) {
            createdCell.title = `Aktualisiert: ${formatTimestamp(entry.updatedAt)} | Erstellt: ${formatTimestamp(
                entry.createdAt
            )}`;
        } else if (entry.createdAt) {
            createdCell.title = `Gespeichert: ${formatTimestamp(entry.createdAt)}`;
        }

        const actionsCell = document.createElement("td");
        actionsCell.className = "history-actions";
        const editButton = document.createElement("button");
        editButton.type = "button";
        editButton.className = "button-inline";
        editButton.dataset.action = "load-entry";
        editButton.dataset.entryId = entry.id;
        editButton.textContent = "Bearbeiten";

        const deleteButton = document.createElement("button");
        deleteButton.type = "button";
        deleteButton.className = "button-inline danger";
        deleteButton.dataset.action = "delete-entry";
        deleteButton.dataset.entryId = entry.id;
        deleteButton.textContent = "Loeschen";

        actionsCell.append(editButton, deleteButton);

        row.append(dateCell, zoneCell, responsibleCell, createdCell, actionsCell);
        historyBody.appendChild(row);
    });
}

function renderStatistics(entries) {
    if (!statisticsContent) {
        return;
    }
    statisticsContent.innerHTML = "";

    if (!entries || entries.length < 2) {
        statisticsContent.appendChild(createEmptyMessage("Mindestens zwei Eintraege erforderlich."));
        return;
    }

    const chronological = sortEntriesByDate(entries);

    const stats = computeChangeStatistics(chronological);
    if (!stats) {
        statisticsContent.appendChild(createEmptyMessage("Keine Statistiken verfuegbar."));
        return;
    }

    const overviewCard = document.createElement("div");
    overviewCard.className = "stat-card";
    const overviewHeading = document.createElement("h3");
    overviewHeading.textContent = "Ueberblick";
    overviewCard.appendChild(overviewHeading);
    const overviewList = document.createElement("ul");
    [
        `Gespeicherte Eintraege: ${stats.totalEntries}`,
        `Verglichene Tagespaare: ${stats.comparedPairs}`,
        `Durchschnitt geaenderte Felder: ${stats.avgChanges.toFixed(1)}`
    ].forEach(text => {
        const li = document.createElement("li");
        li.textContent = text;
        overviewList.appendChild(li);
    });
    overviewCard.appendChild(overviewList);
    statisticsContent.appendChild(overviewCard);

    if (stats.topFields.length) {
        const topFieldsCard = document.createElement("div");
        topFieldsCard.className = "stat-card";
        const topHeading = document.createElement("h3");
        topHeading.textContent = "Haeufig geaenderte Felder";
        topFieldsCard.appendChild(topHeading);
        const list = document.createElement("ul");
        stats.topFields.slice(0, 8).forEach(item => {
            const li = document.createElement("li");
            li.textContent = `${item.label}: ${item.count}x`;
            list.appendChild(li);
        });
        topFieldsCard.appendChild(list);
        statisticsContent.appendChild(topFieldsCard);
    }

    if (stats.perEntry.length) {
        const recentCard = document.createElement("div");
        recentCard.className = "stat-card";
        const recentHeading = document.createElement("h3");
        recentHeading.textContent = "Letzte Eintraege";
        recentCard.appendChild(recentHeading);
        const list = document.createElement("ul");
        stats.perEntry
            .slice(-5)
            .reverse()
            .forEach(item => {
                const label = formatDate(item.date) || formatTimestamp(item.createdAt);
                const fieldsPreview = item.fields.slice(0, 4).map(humanizeFieldName).join(", ");
                const li = document.createElement("li");
                if (fieldsPreview) {
                    li.textContent = `${label}: ${item.count} Felder (${fieldsPreview})`;
                } else {
                    li.textContent = `${label}: ${item.count} Felder`;
                }
                list.appendChild(li);
            });
        if (!list.children.length) {
            const li = document.createElement("li");
            li.textContent = "Keine Abweichungen erkannt.";
            list.appendChild(li);
        }
        recentCard.appendChild(list);
        statisticsContent.appendChild(recentCard);
    }
}

function renderTrends(entries) {
    if (!trendContent) {
        return;
    }
    trendContent.innerHTML = "";

    if (!entries || entries.length < 2) {
        trendContent.appendChild(
            createEmptyMessage("Noch keine Trends verfuegbar. Zuerst mindestens zwei Tagesprotokolle speichern.")
        );
        return;
    }

    const chronological = sortEntriesByDate(entries);
    const trendResults = TREND_FIELDS.map(def => analyzeTrend(def, chronological)).filter(Boolean);

    if (!trendResults.length) {
        trendContent.appendChild(createEmptyMessage("Keine numerischen Werte fuer Trendanalyse gefunden."));
        return;
    }

    const counts = trendResults.reduce(
        (acc, item) => {
            acc[item.direction] = (acc[item.direction] || 0) + 1;
            return acc;
        },
        { up: 0, down: 0, steady: 0 }
    );

    const summaryCard = document.createElement("div");
    summaryCard.className = "stat-card";
    const summaryHeading = document.createElement("h3");
    summaryHeading.textContent = "Kurzuebersicht";
    summaryCard.appendChild(summaryHeading);
    const summaryList = document.createElement("ul");
    ["Steigend", "Sinkend", "Stabil"].forEach((label, index) => {
        const key = index === 0 ? "up" : index === 1 ? "down" : "steady";
        const li = document.createElement("li");
        li.textContent = `${label}: ${counts[key] || 0}`;
        summaryList.appendChild(li);
    });
    summaryCard.appendChild(summaryList);
    trendContent.appendChild(summaryCard);

    const detailCard = document.createElement("div");
    detailCard.className = "stat-card";
    const detailHeading = document.createElement("h3");
    detailHeading.textContent = "Trend nach Kennzahl";
    detailCard.appendChild(detailHeading);

    const list = document.createElement("ul");
    list.className = "trend-list";

    trendResults
        .sort((a, b) => {
            if (a.direction === b.direction) {
                return Math.abs(b.delta) - Math.abs(a.delta);
            }
            if (a.direction === "up") {
                return -1;
            }
            if (b.direction === "up") {
                return 1;
            }
            if (a.direction === "down") {
                return -1;
            }
            if (b.direction === "down") {
                return 1;
            }
            return 0;
        })
        .forEach(trend => {
            const item = document.createElement("li");
            item.className = `trend-item trend-${trend.direction}`;

            const indicator = document.createElement("span");
            indicator.className = "trend-indicator";
            indicator.textContent = trendSymbol(trend.direction);

            const name = document.createElement("span");
            name.className = "trend-name";
            name.textContent = trend.label;

            const change = document.createElement("span");
            change.className = "trend-change";
            change.textContent = `${trendDirectionLabel(trend.direction)} | ${formatTrendDescription(trend)}`;

            item.append(indicator, name, change);
            list.appendChild(item);
        });

    detailCard.appendChild(list);
    trendContent.appendChild(detailCard);
}

function analyzeTrend(definition, entries) {
    const series = [];
    entries.forEach(entry => {
        const value = getNumericFieldValue(entry.data, definition.key);
        if (value === null) {
            return;
        }
        const dateValue = extractEntryDate(entry) || entry.createdAt || entry.updatedAt || "";
        series.push({
            value,
            date: dateValue,
            sortKey: normalizeDateForSort(dateValue)
        });
    });

    if (series.length < 2) {
        return null;
    }

    series.sort((a, b) => a.sortKey.localeCompare(b.sortKey));

    const first = series[0];
    const last = series[series.length - 1];
    const previous = series[series.length - 2];
    const delta = last.value - first.value;
    const stepDelta = last.value - previous.value;
    const tolerance = determineTrendTolerance(definition, first.value);

    let direction = "steady";
    if (Math.abs(delta) > tolerance) {
        direction = delta > 0 ? "up" : "down";
    }

    return {
        key: definition.key,
        label: humanizeFieldName(definition.key),
        unit: definition.unit || "",
        direction,
        delta,
        stepDelta,
        firstValue: first.value,
        lastValue: last.value,
        samples: series.length,
        latestDate: last.date
    };
}

function getNumericFieldValue(data, key) {
    if (!data || typeof data !== "object") {
        return null;
    }
    const raw = data[key];
    if (raw === undefined || raw === null || raw === "") {
        return null;
    }
    if (typeof raw === "number" && Number.isFinite(raw)) {
        return raw;
    }
    const parsed = Number.parseFloat(String(raw).replace(",", "."));
    return Number.isFinite(parsed) ? parsed : null;
}

function determineTrendTolerance(definition, firstValue) {
    if (typeof definition.tolerance === "number" && definition.tolerance >= 0) {
        return definition.tolerance;
    }
    const unit = (definition.unit || "").toLowerCase();
    if (unit === "#" || unit === "min") {
        return 0.75;
    }
    if (unit === "h") {
        return 0.1;
    }
    const base = Math.abs(firstValue || 0);
    return Math.max(0.2, base * 0.03);
}

function trendSymbol(direction) {
    switch (direction) {
        case "up":
            return "+";
        case "down":
            return "-";
        default:
            return "~";
    }
}

function trendDirectionLabel(direction) {
    switch (direction) {
        case "up":
            return "steigend";
        case "down":
            return "sinkend";
        default:
            return "stabil";
    }
}

function formatTrendDescription(trend) {
    const unit = trend.unit || "";
    const lastText = formatValue(trend.lastValue, unit);
    const deltaText = formatSigned(trend.delta, unit);
    const stepText = formatSigned(trend.stepDelta, unit);
    return `Letzter Wert ${lastText} | Gesamt ${deltaText} | Zum Vortag ${stepText}`;
}

function formatValue(value, unit) {
    if (!Number.isFinite(value)) {
        return "-";
    }
    const suffix = unit ? ` ${unit}` : "";
    return `${formatNumber(value)}${suffix}`;
}

function formatSigned(value, unit) {
    if (!Number.isFinite(value) || value === 0) {
        return `0${unit ? ` ${unit}` : ""}`;
    }
    const prefix = value > 0 ? "+" : "-";
    const suffix = unit ? ` ${unit}` : "";
    return `${prefix}${formatNumber(Math.abs(value))}${suffix}`;
}

function formatNumber(value) {
    if (!Number.isFinite(value)) {
        return "0";
    }
    const abs = Math.abs(value);
    let decimals = 0;
    if (abs < 1) {
        decimals = 2;
    } else if (abs < 10) {
        decimals = 1;
    } else if (abs < 100 && Math.abs(value % 1) > 0.0001) {
        decimals = 1;
    }
    const fixed = value.toFixed(decimals);
    const normalized = Number.parseFloat(fixed);
    return Number.isFinite(normalized) ? normalized.toString() : fixed;
}

function sortEntriesByDate(entries) {
    return entries.slice().sort((a, b) => entrySortKey(a).localeCompare(entrySortKey(b)));
}

function entrySortKey(entry) {
    const primary = normalizeDateForSort(extractEntryDate(entry));
    if (primary) {
        return primary;
    }
    const fallback = entry.createdAt || entry.updatedAt || "";
    return normalizeDateForSort(fallback);
}

function extractEntryDate(entry) {
    if (!entry) {
        return "";
    }
    return entry.meta?.date || entry.data?.meta_date || "";
}

function normalizeDateForSort(value) {
    if (!value) {
        return "";
    }
    if (value instanceof Date) {
        return value.toISOString();
    }
    if (typeof value === "string") {
        if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
            return `${value}T00:00:00`;
        }
        const parsed = new Date(value);
        if (!Number.isNaN(parsed.getTime())) {
            return parsed.toISOString();
        }
        return value;
    }
    return String(value);
}

function computeChangeStatistics(entries) {
    if (!entries || entries.length < 2) {
        return null;
    }

    const changeCounter = new Map();
    const perEntry = [];
    let totalChanged = 0;

    for (let index = 1; index < entries.length; index += 1) {
        const previous = entries[index - 1];
        const current = entries[index];
        const diff = diffEntries(previous.data, current.data);
        totalChanged += diff.changedFields.length;

        diff.changedFields.forEach(field => {
            const count = changeCounter.get(field) || 0;
            changeCounter.set(field, count + 1);
        });

        perEntry.push({
            id: current.id,
            date: current.meta?.date || current.data?.meta_date || "",
            createdAt: current.createdAt,
            count: diff.changedFields.length,
            fields: diff.changedFields
        });
    }

    const topFields = Array.from(changeCounter.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([field, count]) => ({
            field,
            label: humanizeFieldName(field),
            count
        }));

    return {
        totalEntries: entries.length,
        comparedPairs: entries.length - 1,
        avgChanges: perEntry.length ? totalChanged / perEntry.length : 0,
        topFields,
        perEntry
    };
}

function diffEntries(previous = {}, current = {}) {
    const keys = new Set([...Object.keys(previous), ...Object.keys(current)]);
    const changedFields = [];

    keys.forEach(key => {
        const prevValue = previous[key];
        const currValue = current[key];

        if (Array.isArray(prevValue) || Array.isArray(currValue)) {
            if (!arraysEqual(prevValue, currValue)) {
                changedFields.push(key);
            }
            return;
        }

        if (isPlainObject(prevValue) || isPlainObject(currValue)) {
            if (!isDeepEqual(prevValue, currValue)) {
                changedFields.push(key);
            }
            return;
        }

        if (!isSameScalar(prevValue, currValue)) {
            changedFields.push(key);
        }
    });

    return {
        changedFields: Array.from(new Set(changedFields))
    };
}

function arraysEqual(first = [], second = []) {
    if (!Array.isArray(first) || !Array.isArray(second)) {
        return false;
    }
    if (first.length !== second.length) {
        return false;
    }
    const stringA = JSON.stringify(first);
    const stringB = JSON.stringify(second);
    return stringA === stringB;
}

function isPlainObject(value) {
    return Object.prototype.toString.call(value) === "[object Object]";
}

function isDeepEqual(a, b) {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function isSameScalar(a, b) {
    const normalizedA = normalizeScalar(a);
    const normalizedB = normalizeScalar(b);
    return normalizedA === normalizedB;
}

function normalizeScalar(value) {
    if (value === null || value === undefined) {
        return "";
    }
    if (typeof value === "boolean") {
        return value ? "true" : "false";
    }
    if (typeof value === "number") {
        return Number.isFinite(value) ? String(value) : "";
    }
    return String(value).trim();
}

function humanizeFieldName(key) {
    const map = {
        meta_date: "Datum",
        meta_zone: "Gewaechshaus / Zone",
        meta_crop: "Kultur",
        meta_responsible: "Verantwortlich",
        meta_shift: "Schicht",
        climate_inside_temp_min: "Innen-Temperatur Minimum",
        climate_inside_temp_max: "Innen-Temperatur Maximum",
        climate_inside_temp_avg: "Innen-Temperatur Durchschnitt",
        climate_outside_temp_min: "Aussen-Temperatur Minimum",
        climate_outside_temp_max: "Aussen-Temperatur Maximum",
        climate_outside_temp_avg: "Aussen-Temperatur Durchschnitt",
        climate_rh_min: "Rel. Luftfeuchte Minimum",
        climate_rh_max: "Rel. Luftfeuchte Maximum",
        climate_rh_avg: "Rel. Luftfeuchte Durchschnitt",
        climate_dewpoint_min: "Taupunkt Minimum",
        climate_dewpoint_max: "Taupunkt Maximum",
        climate_dewpoint_avg: "Taupunkt Durchschnitt",
        climate_vpd_min: "VPD Minimum",
        climate_vpd_max: "VPD Maximum",
        climate_vpd_avg: "VPD Durchschnitt",
        climate_co2_min: "CO2 Minimum",
        climate_co2_max: "CO2 Maximum",
        climate_co2_avg: "CO2 Durchschnitt",
        climate_co21000_duration: "CO2 Dauer ueber 1000 ppm",
        light_dli_value: "DLI",
        light_ppfd_value: "PPFD",
        light_hours_value: "Beleuchtungsstunden",
        light_outage_count: "Lichtausfaelle",
        pest_traps_count: "Fallenanzahl",
        actions_todo: "To-do fuer morgen"
    };
    if (map[key]) {
        return map[key];
    }
    const section = repeatingSections.find(item => item.key === key);
    if (section) {
        return labelForKey(key);
    }
    return key
        .replace(/_/g, " ")
        .replace(/\b\w/g, char => char.toUpperCase());
}

function createEmptyMessage(text) {
    const paragraph = document.createElement("p");
    paragraph.className = "empty-state";
    paragraph.textContent = text;
    return paragraph;
}

function formatTimestamp(value) {
    if (!value) {
        return "-";
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return value;
    }
    return `${date.toLocaleDateString("de-DE")} ${date.toLocaleTimeString("de-DE", {
        hour: "2-digit",
        minute: "2-digit"
    })}`;
}

function formatDate(value) {
    if (!value) {
        return "";
    }
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
        return date.toLocaleDateString("de-DE");
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        const [year, month, day] = value.split("-");
        return `${day}.${month}.${year}`;
    }
    return value;
}

function createEntryId(dateValue) {
    const base = dateValue && typeof dateValue === "string" ? dateValue : "eintrag";
    const safeBase = base.replace(/[^a-zA-Z0-9]/g, "-");
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return `${safeBase}-${crypto.randomUUID()}`;
    }
    return `${safeBase}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
}

function createDatabase() {
    if (typeof indexedDB === "undefined") {
        console.warn("IndexedDB wird nicht unterstuetzt. Fallback auf localStorage.");
        return new LocalStorageAdapter(ENTRY_STORAGE_KEY);
    }
    return new IndexedDbAdapter();
}

class IndexedDbAdapter {
    constructor() {
        this.dbPromise = this.init();
    }

    async ready() {
        await this.dbPromise;
    }

    init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(DB_STORE_NAME)) {
                    db.createObjectStore(DB_STORE_NAME, { keyPath: "id" });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async getDb() {
        return this.dbPromise;
    }

    async save(entry) {
        const db = await this.getDb();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(DB_STORE_NAME, "readwrite");
            const store = transaction.objectStore(DB_STORE_NAME);
            store.put(entry);
            transaction.oncomplete = () => resolve(entry);
            transaction.onerror = () => reject(transaction.error);
        });
    }

    async getAll() {
        const db = await this.getDb();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(DB_STORE_NAME, "readonly");
            const store = transaction.objectStore(DB_STORE_NAME);
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    }

    async get(id) {
        const db = await this.getDb();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(DB_STORE_NAME, "readonly");
            const store = transaction.objectStore(DB_STORE_NAME);
            const request = store.get(id);
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error);
        });
    }

    async delete(id) {
        const db = await this.getDb();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(DB_STORE_NAME, "readwrite");
            const store = transaction.objectStore(DB_STORE_NAME);
            store.delete(id);
            transaction.oncomplete = () => resolve(true);
            transaction.onerror = () => reject(transaction.error);
        });
    }
}

class LocalStorageAdapter {
    constructor(key) {
        this.key = key;
    }

    async ready() {
        return undefined;
    }

    async save(entry) {
        const entries = await this.getAll();
        const existingIndex = entries.findIndex(item => item.id === entry.id);
        if (existingIndex >= 0) {
            entries[existingIndex] = entry;
        } else {
            entries.push(entry);
        }
        localStorage.setItem(this.key, JSON.stringify(entries));
        return entry;
    }

    async getAll() {
        const raw = localStorage.getItem(this.key);
        if (!raw) {
            return [];
        }
        try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        } catch (error) {
            console.warn("Konnte gespeicherte Eintraege nicht lesen.", error);
            return [];
        }
    }

    async get(id) {
        const entries = await this.getAll();
        return entries.find(item => item.id === id) || null;
    }

    async delete(id) {
        const entries = await this.getAll();
        const filtered = entries.filter(item => item.id !== id);
        localStorage.setItem(this.key, JSON.stringify(filtered));
        return true;
    }
}

function createStatusHost() {
    const container = document.createElement("div");
    container.className = "status-host";
    container.setAttribute("role", "status");
    container.setAttribute("aria-live", "polite");
    document.body.appendChild(container);
    return container;
}

function announce(message, variant = "info") {
    if (!statusHost) {
        return;
    }
    const item = document.createElement("div");
    item.className = `status-message status-${variant}`;
    item.textContent = message;
    statusHost.appendChild(item);
    window.setTimeout(() => {
        item.classList.add("visible");
    }, 10);
    window.setTimeout(() => {
        item.classList.remove("visible");
        window.setTimeout(() => {
            item.remove();
        }, 300);
    }, 3200);
}
init();

