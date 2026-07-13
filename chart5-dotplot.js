// Group 05 · Meriam Ferjani, Ghofrane Faidi

/*

This file builds Chart 5: the Diverging Dot Plot.

This chart only comes alive once you've "pinned" 1-3 alloys in another
chart (Chart 1, 2, or 3 - clicking an amber Pareto point or a line pins
it). For each pinned alloy, and for every element/property, it shows a dot
positioned by how far that alloy's value is from a comparison average -
measured in "standard deviations" (written as σ, a common way statisticians
describe "how unusual is this value compared to typical"). A dot sitting
right on the center line (0σ) means "totally average"; a dot far to the
right means "way higher than typical"; far to the left means "way lower".

This lets you quickly see, for a specific pinned alloy: "which of its
ingredients/properties are unusually high or low compared to the rest of
the dataset (or compared to just the Pareto front, or just your current
filtered selection)?"

Rows are grouped into up to 4 sections: Chemical Composition, Microstructure,
Mechanical Properties, and Thermophysical Properties - same category system
used in the other charts.
*/

const PIN_COLORS = ["#7c3aed", "#0284c7", "#ea580c"]; // purple, sky-blue, orange (CVD-safe) - one distinct color per pinned alloy (up to 3)
let dotPlotWidth = 780, dotPlotRowHeight = 34;
let dotPlotMargin = { top: 20, right: 40, bottom: 30, left: 210 };

// Formats a number for display in a readable way depending on its size
// (e.g. very small or very large numbers use scientific-style precision,
// "normal" numbers just get a sensible number of decimal places)
function fmtMean(v) {
    if (!isFinite(v)) return "-";
    let abs = Math.abs(v);
    if (abs === 0) return "0";
    if (abs >= 1e6 || (abs < 0.001 && abs > 0)) return v.toPrecision(3);
    if (abs >= 100) return v.toFixed(1);
    if (abs >= 1) return v.toFixed(2);
    return v.toFixed(3);
}
let compareTo = "full";          // what the pinned alloys get compared against: "full" dataset, "pareto" front, or "active" (current filter selection)
let sortByDeviation = false;     // if true, rows are sorted so the most "unusual" ones show up first
let lastFilteredElement = null;  // remembers which element you last clicked to filter by (see filterByElementNeighborhood below)
let fullDatasetStatsCache = null; // caches the full-dataset mean/std so we don't recompute it on every redraw (it never changes unless the file itself changes)
let pinColorMap = new Map();      // remembers which pinned alloy id got which of the 3 colors, kept STABLE across redraws
let chart5Ready = false;

// ------------------------------------------------------------------
// createChart5(): sets up the empty container for chart 5. Most of the
// actual building happens in renderChart5 below, since this chart's
// content entirely depends on which alloys are pinned (which can change
// at any time from other charts).
// ------------------------------------------------------------------
function createChart5() {
    chart5.selectAll("*").remove();
    lastFilteredElement = null;
    pinColorMap = new Map();
    fullDatasetStatsCache = null;
    chart5.append("div").attr("id", "dotPlotContainer");
    chart5Ready = true;
    renderChart5();
}

// ------------------------------------------------------------------
// getElementStats(): works out the average (mean) and spread (std =
// standard deviation) for each element/property, based on whichever
// "compare to" group is currently selected. This is what a pinned alloy's
// dot position gets measured against.
// ------------------------------------------------------------------
function getElementStats(elements) {
    if (compareTo === "full" && fullDatasetStatsCache) return fullDatasetStatsCache; // reuse the cached version if nothing's changed

    let referenceRows = compareTo === "active" ? activeRows() :
        compareTo === "pareto" ? alloyData.filter(d => d.__pareto) :
            alloyData;
    let stats = {};
    elements.forEach(el => {
        let vals = referenceRows.map(d => d[el]);
        stats[el] = { mean: d3.mean(vals), std: d3.deviation(vals) || 1 }; // avoid a std of 0 (would cause divide-by-zero later)
    });
    stats.__n = referenceRows.length;

    if (compareTo === "full") fullDatasetStatsCache = stats;
    return stats;
}

// ------------------------------------------------------------------
// getStableColors(): assigns each currently-pinned alloy id one of the 3
// PIN_COLORS, and - importantly - keeps that assignment STABLE across
// redraws (so if alloy A is purple, it stays purple even if you later pin
// a second alloy B, instead of the colors shuffling around confusingly).
// ------------------------------------------------------------------
function getStableColors(ids) {
    // Forget colors for anything that's no longer pinned
    for (let id of [...pinColorMap.keys()]) {
        if (!ids.includes(id)) pinColorMap.delete(id);
    }
    // Give any newly-pinned id the first color not currently in use
    ids.forEach(id => {
        if (!pinColorMap.has(id)) {
            let used = new Set(pinColorMap.values());
            pinColorMap.set(id, PIN_COLORS.find(c => !used.has(c)) || PIN_COLORS[0]);
        }
    });
    return pinColorMap;
}

// ------------------------------------------------------------------
// renderChart5(): (re)draws the whole chart - called whenever a pin
// changes, the "compare to" choice changes, sorting toggles, or a filter changes.
// ------------------------------------------------------------------
function renderChart5() {
    let container = d3.select("#dotPlotContainer");
    container.selectAll("*").remove(); // full rebuild every time - this chart is cheap enough (only a few pinned alloys) that this is simpler than patching it

    if (pinnedIds.length === 0) {
        container.append("p").attr("class", "chart-stub-note")
            .text("Pin up to 3 alloys (click an amber Pareto point in the PCP or Scatterplot) to compare their elemental composition here.");
        return;
    }

    let pinned = pinnedIds.map(id => alloyById.get(id)).filter(Boolean);
    if (pinned.length === 0) {
        container.append("p").attr("class", "chart-stub-note")
            .text("Pinned alloys could not be found in the current dataset, try unpinning and re-pinning.");
        return;
    }

    // Build the full list of rows to show, split into up to 4 category
    // sections (mirrors the "Chemical Composition / Microstructure /
    // Mechanical Properties / Thermophysical Properties" grouping used in
    // the other charts)
    const chemCols = COLUMNS.chemistry.slice();
    const microCols = MICROSTRUCTURE_AXES.filter(c => alloyData.length > 0 && c in alloyData[0]);
    const mechCols = MECHANICAL_AXES.slice();
    const thermoCols = THERMOPHYSICAL_AXES.filter(c => alloyData.length > 0 && c in alloyData[0]);
    let allCols = [...chemCols, ...microCols, ...mechCols, ...thermoCols];
    let stats = getElementStats(allCols);

    let activeCount = activeRows().length;
    let selectionIsFullDataset = activeCount === alloyData.length;

    // If there's no active filter anymore, "current selection" would be
    // identical to "full dataset" - so just fall back to "full" instead of
    // showing a meaningless duplicate option
    if (compareTo === "active" && selectionIsFullDataset) compareTo = "full";

    // ---- "Compare to" buttons ----
    let compareBar = container.append("div").attr("class", "scatter-mode-bar");
    compareBar.append("span").attr("class", "picker-label").text("Compare to: ");
    [
        ["full", "Full dataset"],
        ["pareto", `Pareto front (${paretoIndexSet.size.toLocaleString()} alloys)`],
        ["active", `Current selection (${activeCount.toLocaleString()})`]
    ].forEach(([m, lbl]) => {
        let isDisabled = m === "active" && selectionIsFullDataset;
        compareBar.append("button")
            .attr("class", "mode-btn" + (compareTo === m ? " active" : ""))
            .attr("disabled", isDisabled ? true : null)
            .attr("title", isDisabled ? "No filter active — current selection equals the full dataset" : null)
            .text(lbl)
            .on("click", () => { if (!isDisabled) { compareTo = m; renderChart5(); } });
    });
    // ---- "Sort by deviation" toggle ----
    let sortBar = container.append("div").attr("class", "scatter-mode-bar");
    sortBar.append("button")
        .attr("class", "mode-btn" + (sortByDeviation ? " active" : ""))
        .text("Sort by deviation")
        .attr("title", "Order elements by how much the pinned alloys differ from the comparison mean, largest first")
        .on("click", () => { sortByDeviation = !sortByDeviation; renderChart5(); });

    let colorFor = getStableColors(pinnedIds);

    // Small helper: if "sort by deviation" is on, reorder a section's
    // columns so the ones where the pinned alloys differ most from the
    // comparison mean show up first
    function sortCols(cols) {
        if (!sortByDeviation) return cols;
        let maxDevFor = el => Math.max(...pinned.map(d => Math.abs((d[el] - stats[el].mean) / stats[el].std)));
        return cols.slice().sort((a, b) => maxDevFor(b) - maxDevFor(a));
    }

    // The 4 sections to draw, in order, each with its own label/color - any
    // section with no columns available in this dataset is simply skipped
    const SECTIONS = [
        { cols: sortCols(chemCols), label: "Chemical Composition", color: "#16a34a" },
        { cols: sortCols(microCols), label: "Microstructure", color: "#0891b2" },
        { cols: sortCols(mechCols), label: "Mechanical Properties", color: "#be123c" },
        { cols: sortCols(thermoCols), label: "Thermophysical Properties", color: "#7c3aed" }
    ].filter(section => section.cols.length > 0);

    // Work out the total height needed: one row per element/property, plus
    // a header + gap for each visible section
    const SECTION_HEADER_HEIGHT = 20;
    const SEPARATOR_HEIGHT = 12;
    const totalRows = SECTIONS.reduce((sum, section) => sum + section.cols.length, 0);
    const totalHeight = totalRows * dotPlotRowHeight
        + SECTION_HEADER_HEIGHT * SECTIONS.length
        + SEPARATOR_HEIGHT * (SECTIONS.length - 1);

    // Find the single most extreme z-score across every row/pinned alloy,
    // so the x-axis range can be set wide enough to fit every dot without clipping
    let maxAbsZ = 3;
    pinned.forEach(d => {
        allCols.forEach(el => {
            let z = Math.abs((d[el] - stats[el].mean) / stats[el].std);
            if (z > maxAbsZ) maxAbsZ = z;
        });
    });
    maxAbsZ *= 1.1; // add a little breathing room so the most extreme dot isn't touching the very edge

    let _cNode = container.node();
    let effectivePlotWidth = _cNode ? Math.max(500, Math.min(940, _cNode.clientWidth - 10)) : dotPlotWidth;

    let plotWidth = effectivePlotWidth - dotPlotMargin.left - dotPlotMargin.right;
    let x = d3.scaleLinear().domain([-maxAbsZ, maxAbsZ]).range([0, plotWidth]); // the shared x-axis: standard deviations away from the mean
    let height = dotPlotMargin.top + dotPlotMargin.bottom + totalHeight;

    let svg = container.append("svg").attr("width", effectivePlotWidth).attr("height", height)
        .append("g").attr("transform", `translate(${dotPlotMargin.left},${dotPlotMargin.top})`);

    // ---- legend: one colored dot + alloy id per pinned alloy ----
    let legend = container.append("div").attr("class", "dotplot-legend");
    pinned.forEach(d => {
        let item = legend.append("span").attr("class", "legend-item");
        item.append("span").attr("class", "color-circle").style("background-color", colorFor.get(d.__id));
        item.append("span").text(" " + d.__id);
    });

    // Shade the "within 1 standard deviation" band lightly gray, so it's
    // obvious at a glance which dots are inside vs. outside "typical" range
    svg.append("rect")
        .attr("x", x(-1)).attr("y", 0)
        .attr("width", x(1) - x(-1)).attr("height", totalHeight)
        .attr("fill", "rgba(0,0,0,0.04)").attr("pointer-events", "none");

    // Dashed reference lines at -2σ, -1σ, +1σ, +2σ, with small labels along the bottom
    [-2, -1, 1, 2].forEach(sv => {
        svg.append("line")
            .attr("x1", x(sv)).attr("x2", x(sv))
            .attr("y1", 0).attr("y2", totalHeight)
            .attr("stroke", Math.abs(sv) === 2 ? "#d4d4d4" : "#a3a3a3")
            .attr("stroke-dasharray", "3,3")
            .attr("pointer-events", "none");
        svg.append("text")
            .attr("x", x(sv)).attr("y", totalHeight + 14)
            .attr("text-anchor", "middle")
            .attr("class", "chart-hint")
            .style("font-size", "10px")
            .text((sv > 0 ? "+" : "") + sv + "σ");
    });

    // center reference line
    // The solid center line at 0σ = "exactly average" for whichever comparison group is chosen
    let referenceLabel = compareTo === "full" ? "full-dataset mean" :
        compareTo === "pareto" ? `Pareto-front mean (n=${stats.__n.toLocaleString()})` :
            `current-selection mean (n=${stats.__n.toLocaleString()})`;
    svg.append("line")
        .attr("x1", x(0)).attr("x2", x(0))
        .attr("y1", 0).attr("y2", totalHeight)
        .attr("stroke", "#999").attr("stroke-dasharray", "3,3");
    svg.append("text").attr("x", x(0)).attr("y", -6).attr("text-anchor", "middle")
        .attr("class", "chart-hint").text(referenceLabel);
    svg.append("text")
        .attr("x", x(0)).attr("y", totalHeight + 14)
        .attr("text-anchor", "middle")
        .attr("class", "chart-hint")
        .style("font-size", "10px")
        .text("0σ");

    // ------------------------------------------------------------------
    // drawSection(): draws one category block (its header + one row per
    // column in that category, each row showing a dot per pinned alloy).
    // Returns the y-position where the NEXT section should start.
    // ------------------------------------------------------------------
    function drawSection(cols, offsetY, sectionLabel, sectionColor) {
        svg.append("text")
            .attr("x", plotWidth / 2)
            .attr("y", offsetY + SECTION_HEADER_HEIGHT - 5)
            .attr("text-anchor", "middle")
            .attr("class", "dotplot-section-label")
            .style("fill", sectionColor)
            .text(sectionLabel);

        cols.forEach((el, i) => {
            let rowY = offsetY + SECTION_HEADER_HEIGHT + i * dotPlotRowHeight + dotPlotRowHeight / 2;
            let row = svg.append("g").attr("class", "dotplot-row");

            row.append("line").attr("x1", 0).attr("x2", plotWidth).attr("y1", rowY).attr("y2", rowY)
                .attr("stroke", "#e5e5e5");

            // Chemistry and solidification-related labels are clickable:
            // clicking one sets a PCP filter to a range around the pinned
            // alloys' values for that element (see filterByElementNeighborhood below)
            let isClickable = COLUMNS.chemistry.includes(el) || SOLIDIFICATION_AXES.includes(el);
            row.append("text").attr("x", -10).attr("y", rowY + 4).attr("text-anchor", "end")
                .attr("class", "dotplot-element-label")
                .style("cursor", isClickable ? "pointer" : "default")
                .text(`${label(el)} (μ=${fmtMean(stats[el].mean)})`)
                .on("click", isClickable ? () => filterByElementNeighborhood(el, pinned, stats) : null)
                .append("title").text(isClickable
                    ? "Click to filter the PCP to alloys near these pinned alloys' " + label(el) + " content"
                    : label(el) + " — z-score vs. " + referenceLabel);

            // One dot per pinned alloy, positioned by its z-score (how many
            // standard deviations away from the mean its value for this column is)
            pinned.forEach(d => {
                let z = (d[el] - stats[el].mean) / stats[el].std;
                row.append("circle")
                    .attr("cx", x(z)).attr("cy", rowY).attr("r", 5)
                    .attr("fill", colorFor.get(d.__id)).attr("stroke", "#fff").attr("stroke-width", 1)
                    .style("cursor", "pointer")
                    .on("mouseover", (event) => {
                        let tooltip = d3.select(".tooltip");
                        if (tooltip.empty()) tooltip = d3.select("body").append("div").attr("class", "tooltip").style("opacity", 0);
                        tooltip.transition().duration(100).style("opacity", 0.95);
                        tooltip.html(`<b>${d.__id}</b><br/>${label(el)}: ${d[el].toFixed(3)}<br/>deviation: ${z >= 0 ? "+" : ""}${z.toFixed(2)}σ`)
                            .style("left", (event.pageX + 12) + "px").style("top", (event.pageY - 20) + "px");
                    })
                    .on("mouseout", hidePcpTooltip);
            });
        });

        return offsetY + SECTION_HEADER_HEIGHT + cols.length * dotPlotRowHeight;
    }

    // Draw each section one after another, stacked vertically, with a
    // divider line in the gap between two consecutive sections
    let offsetY = 0;
    SECTIONS.forEach((section, i) => {
        if (i > 0) {
            svg.append("line")
                .attr("x1", 0).attr("x2", plotWidth)
                .attr("y1", offsetY + SEPARATOR_HEIGHT / 2).attr("y2", offsetY + SEPARATOR_HEIGHT / 2)
                .attr("stroke", "#d1d5db").attr("stroke-width", 1.5);
            offsetY += SEPARATOR_HEIGHT;
        }
        offsetY = drawSection(section.cols, offsetY, section.label, section.color);
    });


    container.append("div").attr("class", "chart-export-row")
        .append("button").attr("class", "export-btn")
        .text("↓ Export SVG")
        .on("click", () => {
            let svgEl = d3.select("#dotPlotContainer svg").node();
            if (svgEl) exportSvgEl(svgEl, "diverging-dotplot.svg");
        });

    let note = container.append("p").attr("class", "chart-hint").attr("id", "dotplotFilterNote");
    updateFilterNote(note);
}

// Shows/hides the little note explaining that the PCP is currently
// filtered because you clicked an element label in this chart
function updateFilterNote(noteSelection) {
    let note = noteSelection || d3.select("#dotplotFilterNote");
    if (lastFilteredElement && currentPcpFilters[lastFilteredElement]) {
        let [lo, hi] = currentPcpFilters[lastFilteredElement];
        note.html(`<b>PCP filtered</b> to ${lastFilteredElement} between ${lo.toFixed(3)} and ${hi.toFixed(3)} (click a different element above, or use the PCP's "Reset filters", to change this).`);
    } else {
        note.text("");
    }
}

// ------------------------------------------------------------------
// filterByElementNeighborhood(): triggered by clicking a clickable element
// label. Sets a Parallel Coordinates Plot filter to "within 1 standard
// deviation of the pinned alloys' average value" for that element, so you
// can quickly find OTHER alloys that are chemically similar to the ones
// you've pinned, in that one respect.
// ------------------------------------------------------------------
function filterByElementNeighborhood(el, pinned, stats) {
    let std = stats[el].std;
    let pinnedMean = d3.mean(pinned, d => d[el]);
    currentPcpFilters[el] = [pinnedMean - std, pinnedMean + std];
    if (!currentPcpAxes.includes(el)) currentPcpAxes.push(el); // make sure that column is actually shown as an axis in the PCP so the filter is visible
    lastFilteredElement = el;
    renderChart1(currentPcpAxes, currentPcpFilters);
    if (scatterCtx) renderChart2();
    if (pcaCtx) renderChart3();
    if (heatmapReady) renderChart4();
    updateFilterNote();
}
