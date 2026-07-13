// Group 05 · Meriam Ferjani, Ghofrane Faidi

/*

This file builds Chart 1: the "Parallel Coordinates Plot" (PCP).

If you've never seen one: instead of just 2 axes (like a normal
scatterplot), a PCP draws one VERTICAL axis per column you choose, all
side by side. Each alloy becomes ONE line that zig-zags across all those
axes, touching its value on each one. This lets you compare many columns
at once - way more than the 2 you'd get from a regular x/y chart.

What you can do with it (all handled in this file):
  - Tick checkboxes to choose which columns become axes
  - Drag an axis label left/right to reorder the axes
  - Click the little arrow icon to flip an axis upside down
  - Drag up/down ON an axis to "brush" (filter) to a range of values
  - Alloys on the Pareto front are drawn as bright amber lines
  - Pinned alloys are drawn as thick blue lines
  - Everything else is drawn as a faint background line (for speed, only a
    SAMPLE of alloys is drawn as background - see PCP_BACKGROUND_SAMPLE_SIZE
    in dashboard.js)

Performance note: because there can be thousands of lines, the faint
background lines are drawn on an HTML5 <canvas> (fast, but can't be
individually clicked/styled), while the "important" amber/blue lines and
all the interactive bits (axes, drag handles, brushes) are drawn as normal
SVG on TOP of that canvas, since there are only a few of them.
*/

const PCP_MIN_AXIS_COUNT = 2;      // you must always keep at least 2 axes visible
const PCP_MIN_AXIS_SPACING = 70;   // minimum pixel gap between two axes, so labels don't overlap

let pcpWidth = 900, pcpHeight = 460;
let pcpMargin = { top: 40, right: 40, bottom: 34, left: 80 };
let currentPcpAxes, currentPcpFilters, invertedAxes; // which columns are shown, active brush filters, and which axes are flipped
let pcpCanvas, pcpCtx, pcpSvgRoot, pcpSvg;           // the <canvas>, its 2D drawing context, and the SVG layers on top
let pcpHoverGroup = null; // a small SVG group just for drawing the "currently hovered" highlight line
let suppressBrushEvents = false; // a flag to avoid infinite loops when we move a brush programmatically (see below)
let pcpColorBy = COLUMNS.ys; // which column's value controls each line's color

// ------------------------------------------------------------------
// createChart1(): builds the WHOLE chart 1 UI from scratch - the axis
// picker checkboxes, buttons, legend, and the canvas/svg drawing area.
// Called once when the dashboard first loads, and again any time we need
// to fully rebuild the controls (e.g. after a window resize).
// `reset` (default true) controls whether we reset back to the default
// axes/filters, or keep whatever the user currently has set up.
// ------------------------------------------------------------------
function createChart1(reset = true) {
    if (reset) {
        currentPcpAxes = DEFAULT_PCP_AXES.slice();
        currentPcpFilters = {};
        invertedAxes = new Set();
    }

    chart1.selectAll("*").remove(); // wipe anything previously drawn here

    // ---- The axis picker box: category-grouped checkboxes ----
    let picker = chart1.append("div").attr("class", "pcp-axis-picker");
    let pickerCtrl = picker.append("div").attr("class", "pcp-picker-controls");
    pickerCtrl.append("span").attr("class", "picker-label").text("Axes:");
    pickerCtrl.append("button").attr("class", "pcp-reset-btn").text("Select all")
        .on("click", () => {
            currentPcpAxes = CURATED_AXES.slice();
            currentPcpFilters = {};
            invertedAxes = new Set();
            createChart1(false);
        });
    pickerCtrl.append("button").attr("class", "pcp-reset-btn").text("Reset to default")
        .on("click", () => {
            currentPcpAxes = DEFAULT_PCP_AXES.slice();
            currentPcpFilters = {};
            invertedAxes = new Set();
            createChart1(false);
        });
    let minAxesNote = pickerCtrl.append("span").attr("class", "pcp-min-axes-note"); // hidden warning text, shown only if you try to remove too many axes

    // The 5 categories of columns, each with its own color (matches the
    // "axis colour key" legend drawn a bit further down)
    const PCP_GROUPS = [
        { label: "Inputs", color: "#2563eb", cols: COLUMNS.inputs },
        { label: "Chemical Composition", color: "#16a34a", cols: COLUMNS.chemistry },
        { label: "Microstructure", color: "#0891b2", cols: MICROSTRUCTURE_AXES },
        { label: "Mechanical Properties", color: "#be123c", cols: MECHANICAL_AXES },
        { label: "Thermophysical Properties", color: "#7c3aed", cols: THERMOPHYSICAL_AXES }
    ];

    // Draw one checkbox row per group, one checkbox per column in that group
    PCP_GROUPS.forEach(group => {
        let groupDiv = picker.append("div").attr("class", "pcp-axis-group");
        groupDiv.append("span").attr("class", "pcp-group-label").style("color", group.color).text(group.label + ":");
        group.cols.forEach(col => {
            let lbl = groupDiv.append("label").attr("class", "axis-checkbox");
            lbl.append("input").attr("type", "checkbox")
                .attr("checked", currentPcpAxes.includes(col) ? true : null)
                .on("change", function () {
                    if (this.checked) {
                        // Ticking a checkbox ON: add that column as a new axis
                        if (!currentPcpAxes.includes(col)) currentPcpAxes.push(col);
                        minAxesNote.style("display", "none");
                    } else {
                        // Ticking a checkbox OFF: but don't allow going below the minimum axis count
                        if (currentPcpAxes.length <= PCP_MIN_AXIS_COUNT) {
                            this.checked = true; // undo the uncheck
                            minAxesNote.text(`Minimum ${PCP_MIN_AXIS_COUNT} axes required — can't remove this one.`)
                                .style("display", "inline");
                            clearTimeout(window._pcpMinAxesTimer);
                            window._pcpMinAxesTimer = setTimeout(() => minAxesNote.style("display", "none"), 2800);
                            return;
                        }
                        // Otherwise remove that axis, and clean up any filter/inversion tied to it
                        currentPcpAxes = currentPcpAxes.filter(c => c !== col);
                        delete currentPcpFilters[col];
                        invertedAxes.delete(col);
                        minAxesNote.style("display", "none");
                    }
                    renderChart1(currentPcpAxes, currentPcpFilters); // redraw with the new axis list
                });
            lbl.append("span").text(label(col));
        });
    });

    chart1.append("button").attr("class", "pcp-reset-btn").style("margin-bottom", "4px")
        .text("Reset filters")
        .on("click", () => {
            currentPcpFilters = {};
            invertedAxes.clear();
            renderChart1(currentPcpAxes, currentPcpFilters);
        });

    // Axis role legend
    // A small legend row explaining what each axis label color means (matches the checkbox group colors)
    let roleLegend = chart1.append("div")
        .style("font-size", "11px").style("margin", "6px 0 2px")
        .style("display", "flex").style("gap", "14px")
        .style("flex-wrap", "wrap").style("align-items", "center");
    roleLegend.append("span").style("color", "#555").text("Axis colour key:");
    [
        ["#2563eb", "Input (controllable)"],
        ["#16a34a", "Chemical composition (derived)"],
        ["#0891b2", "Microstructure"],
        ["#be123c", "Mechanical property (target)"],
        ["#7c3aed", "Thermophysical property"]
    ].forEach(([color, txt]) => {
        let item = roleLegend.append("span").style("display", "inline-flex").style("align-items", "center").style("gap", "4px");
        item.append("span").style("display", "inline-block").style("width", "10px").style("height", "10px")
            .style("border-radius", "50%").style("background", color).style("flex-shrink", "0");
        item.append("span").style("color", color).style("font-weight", "600").text(txt);
    });

    // Note explaining what the amber lines mean
    let amberNote = roleLegend.append("span").style("display", "inline-flex").style("align-items", "center").style("gap", "4px");
    amberNote.append("span").style("display", "inline-block").style("width", "22px").style("height", "2px")
        .style("background", COLOR_PARETO).style("flex-shrink", "0");
    amberNote.append("span").style("color", COLOR_PARETO).style("font-weight", "600")
        .text("Amber lines = Pareto-optimal (YS ↑ / CSC ↓)");

    // ---- "Color lines by" dropdown: choose which column controls line color ----
    let colorByRow = chart1.append("div")
        .style("display", "inline-flex").style("align-items", "center")
        .style("gap", "6px").style("margin", "4px 0").style("font-size", "12px");
    colorByRow.append("span").attr("class", "picker-label").text("Color lines by:");
    let colorBySel = colorByRow.append("select").style("font-size", "12px");
    const COLORBY_GROUPS = [
        { label: "Mechanical Properties", cols: MECHANICAL_AXES },
        { label: "Thermophysical Properties", cols: THERMOPHYSICAL_AXES },
        { label: "Microstructure", cols: MICROSTRUCTURE_AXES },
        { label: "Inputs", cols: COLUMNS.inputs },
        { label: "Chemical Composition", cols: COLUMNS.chemistry }
    ];
    COLORBY_GROUPS.forEach(g => {
        let og = colorBySel.append("optgroup").attr("label", g.label);
        og.selectAll("option").data(g.cols).enter().append("option")
            .attr("value", d => d).property("selected", d => d === pcpColorBy).text(d => label(d));
    });
    colorBySel.on("change", function () {
        pcpColorBy = this.value;
        renderChart1(currentPcpAxes, currentPcpFilters);
    });

    // ---- Export button (saves the chart as a PNG image) ----
    chart1.append("div").attr("class", "chart-export-row")
        .append("button").attr("class", "export-btn").text("↓ Export PNG")
        .on("click", () => {
            if (pcpCanvas && pcpSvgRoot) exportLayeredChart(pcpSvgRoot.node(), pcpCanvas.node(), "pcp-chart.png");
        });

    // Empty box where the little color-gradient legend gets drawn (see _renderPcpColorLegend below)
    chart1.append("div").attr("id", "pcpColorLegend").attr("class", "pcp-color-legend-html");

    // Figure out how wide the chart area actually has (based on the card's real width on screen)
    let _pcpContainerW = chart1.node() ? chart1.node().clientWidth - 36 : 900;
    pcpWidth = Math.max(600, _pcpContainerW);
    let canvasW = pcpEffectiveWidth(); // the chart may need to be WIDER than the visible area if there are many axes (it'll scroll)

    // A wrapper div that allows horizontal scrolling if the chart is wider than its card
    let wrapper = chart1.append("div")
        .attr("class", "pcp-canvas-wrapper")
        .style("position", "relative")
        .style("width", "100%")
        .style("height", pcpHeight + "px")
        .style("overflow-x", "auto");

    // The <canvas> layer (fast background lines) sits UNDER the SVG layer,
    // both stacked exactly on top of each other using position:absolute
    pcpCanvas = wrapper.append("canvas")
        .attr("width", canvasW).attr("height", pcpHeight)
        .style("position", "absolute").style("top", 0).style("left", 0);
    pcpCtx = pcpCanvas.node().getContext("2d");

    pcpSvgRoot = wrapper.append("svg")
        .attr("width", canvasW).attr("height", pcpHeight)
        .style("position", "absolute").style("top", 0).style("left", 0);
    pcpSvg = pcpSvgRoot.append("g");
    pcpHoverGroup = pcpSvgRoot.append("g").attr("class", "pcp-hover-overlay");

    chart1.append("p").attr("class", "chart-hint")
        .html(
            "Drag an axis label to reorder it &middot; click &#8645; to invert &middot; drag on an axis to brush/filter &middot; click an amber Pareto line to pin it.<br/>" +
            `Lines are colored by the chosen variable (plasma scale). Active lines are bright; lines outside filters are ghosted. ` +
            `Background draws ${PCP_BACKGROUND_SAMPLE_SIZE.toLocaleString()} alloys &mdash; all filter counts and the Pareto front use the full dataset. ` +
            "Pinned alloys (blue) stay visible regardless of filters."
        );

    renderChart1(currentPcpAxes, currentPcpFilters); // now actually draw the lines for the first time
}

// If there are lots of axes packed at the minimum spacing, the chart needs
// to be WIDER than the visible card (so it scrolls) rather than squishing
// axes together illegibly. This works out how wide it needs to be.
function pcpEffectiveWidth() {
    let needed = pcpMargin.left + pcpMargin.right + (currentPcpAxes.length - 1) * PCP_MIN_AXIS_SPACING;
    return Math.max(pcpWidth, needed);
}

// The horizontal scale: converts an axis's NAME (e.g. "YS(MPa)") into its
// pixel x-position. scalePoint evenly spaces out a list of names.
function pcpXScale() {
    return d3.scalePoint()
        .domain(currentPcpAxes)
        .range([pcpMargin.left, pcpEffectiveWidth() - pcpMargin.right]);
}

// One vertical scale PER axis: converts that column's data value into a
// pixel y-position. If the axis has been "inverted" by the user, the
// pixel range is flipped upside down.
function pcpYScales() {
    let scales = {};
    currentPcpAxes.forEach(col => {
        let extent = getExtent(col);
        let range = invertedAxes.has(col)
            ? [pcpMargin.top, pcpHeight - pcpMargin.bottom]
            : [pcpHeight - pcpMargin.bottom, pcpMargin.top];
        scales[col] = d3.scaleLinear().domain(extent).nice().range(range);
    });
    return scales;
}

// Turns one alloy row into the list of (x,y) points its zig-zag line
// should pass through - one point per visible axis
function pcpLinePath(row, x, y) {
    return currentPcpAxes.map(col => [x(col), y[col](row[col])]);
}


// Does this row fall inside every axis's active brush-filter range? (true if there's no filter on an axis at all)
function passesPcpFilters(row) {
    return currentPcpAxes.every(col => {
        let f = currentPcpFilters[col];
        return !f || (row[col] >= f[0] && row[col] <= f[1]);
    });
}

// A row counts as "active" (fully highlighted, not ghosted) if it passes
// the PCP filters AND (if a cross-filter from another chart is active) is
// also part of that cross-filtered set.
function isRowActive(row) {
    if (externalHighlightIds && !externalHighlightIds.has(row.__id)) return false;
    return passesPcpFilters(row);
}

// All alloys (from the FULL dataset, not just the background sample) that currently pass every filter
function activeRows() {
    return alloyData.filter(isRowActive);
}

// ------------------------------------------------------------------
// renderChart1(): the function that actually PAINTS the chart - called
// every time something changes (a filter, axis order, color choice, pin,
// etc.) Re-draws the background canvas lines, the amber/blue overlay
// lines, and all the axis controls (labels, invert buttons, brushes).
// ------------------------------------------------------------------
function renderChart1(axes, filters) {
    if (!pcpCtx) return;

    let effectiveWidth = pcpEffectiveWidth();
    pcpCanvas.attr("width", effectiveWidth);
    pcpSvgRoot.attr("width", effectiveWidth);

    let x = pcpXScale();
    let y = pcpYScales();
    let active = activeRows();
    let activeSet = new Set(active);

    pcpCtx.clearRect(0, 0, effectiveWidth, pcpHeight); // wipe the canvas before redrawing

    // Color scale for the lines: maps the chosen "color by" column's value
    // onto the plasma color scale (dark purple -> bright yellow)
    let [cLo, cHi] = getExtent(pcpColorBy);
    let pcpColorScale = d3.scaleSequential(d3.interpolatePlasma)
        .domain(typeof directionOf === "function" && directionOf(pcpColorBy) === "min"
            ? [cHi, cLo] : [cLo, cHi]);

    // Work out a sensible transparency level for the background lines: if
    // very few lines are active, make them more visible; if there are tons,
    // fade them out more so the chart doesn't turn into a solid blob.
    let nSampleActive = pcpBackgroundSample.filter(r => activeSet.has(r)).length || 1;
    let activeAlpha = Math.min(0.55, Math.max(0.05, 220 / nSampleActive));
    let inactiveAlpha = Math.min(0.03, activeAlpha * 0.1);

    pcpCtx.lineWidth = 0.8;

    // Draw the "ghosted" (filtered-out) background lines first, so active ones can be drawn on top of them
    pcpBackgroundSample.forEach(row => {
        if (activeSet.has(row)) return;
        let col = d3.rgb(pcpColorScale(row[pcpColorBy])).copy({ opacity: inactiveAlpha });
        pcpCtx.beginPath();
        let pts = pcpLinePath(row, x, y);
        pts.forEach(([px, py], i) => (i === 0 ? pcpCtx.moveTo(px, py) : pcpCtx.lineTo(px, py)));
        pcpCtx.strokeStyle = col.toString();
        pcpCtx.stroke();
    });

    // Then draw the "active" (currently passing filters) background lines, brighter
    pcpBackgroundSample.forEach(row => {
        if (!activeSet.has(row)) return;
        let col = d3.rgb(pcpColorScale(row[pcpColorBy])).copy({ opacity: activeAlpha });
        pcpCtx.beginPath();
        let pts = pcpLinePath(row, x, y);
        pts.forEach(([px, py], i) => (i === 0 ? pcpCtx.moveTo(px, py) : pcpCtx.lineTo(px, py)));
        pcpCtx.strokeStyle = col.toString();
        pcpCtx.stroke();
    });

    // Refresh color legend
    _renderPcpColorLegend(cLo, cHi, pcpColorScale);

    // Figure out which rows need a special SVG overlay line: Pareto-optimal
    // ones that are active, pinned ones that are active, and pinned ones
    // that are currently filtered OUT (still shown, but dashed/faded, so
    // pinning something never makes it disappear)
    let paretoActive = active.filter(d => d.__pareto);
    let pinnedActive = active.filter(d => pinnedIds.includes(d.__id) && !d.__pareto);
    let pinnedInactive = alloyData.filter(d => pinnedIds.includes(d.__id) && !activeSet.has(d));
    let overlayRows = paretoActive.concat(pinnedActive, pinnedInactive);

    let lineGen = row => pcpLinePath(row, x, y).map(p => p.join(",")).join(" ");

    // Standard d3 enter/update/exit for the SVG overlay lines
    let paretoLines = pcpSvg.selectAll(".pareto-line")
        .data(overlayRows, d => d.__id);

    paretoLines.exit().remove();

    paretoLines.enter()
        .append("polyline")
        .attr("class", "pareto-line")
        .merge(paretoLines)
        .attr("points", lineGen)
        .attr("fill", "none")
        .attr("stroke", d => pinnedIds.includes(d.__id) ? COLOR_PINNED : COLOR_PARETO)
        .attr("stroke-width", d => pinnedIds.includes(d.__id) ? 3 : 1.5)
        .attr("stroke-dasharray", d => pinnedInactive.includes(d) ? "5,4" : null) // dashed = pinned but currently filtered out
        .attr("opacity", d => pinnedInactive.includes(d) ? 0.45 : 0.85)
        .style("cursor", "pointer")
        .on("click", (event, d) => togglePin(d.__id)) // clicking a highlighted line pins/unpins that alloy
        .on("mouseover", function (event, d) { showPcpTooltip(event, d); setHovered(d.__id); })
        .on("mouseout", () => { hidePcpTooltip(); clearHovered(); });

    // ---- Draw each axis: tick marks, label, invert button, brush ----
    let axisGroups = pcpSvg.selectAll(".pcp-axis").data(axes, d => d);
    axisGroups.exit().remove();

    let axisEnter = axisGroups.enter().append("g").attr("class", "pcp-axis");

    let axisMerged = axisEnter.merge(axisGroups)
        .attr("transform", d => `translate(${x(d)},0)`);

    let axisPixelX = {}; // remembers each axis's current x position (used while dragging to reorder)

    axisMerged.each(function (col) {
        axisPixelX[col] = x(col);
        let g = d3.select(this);
        g.selectAll("*").remove(); // rebuild this axis's contents from scratch each time

        g.append("g").call(d3.axisLeft(y[col]).ticks(6)); // the tick marks + numbers

        // If this axis has an active filter, draw a faint red highlight strip behind it
        let hasFilter = !!currentPcpFilters[col];
        if (hasFilter) {
            g.append("rect")
                .attr("x", -18).attr("y", pcpMargin.top - 8)
                .attr("width", 36).attr("height", pcpHeight - pcpMargin.top - pcpMargin.bottom + 8)
                .attr("fill", "rgba(185,28,28,0.07)").attr("rx", 3).attr("pointer-events", "none");
        }

        // Little up/down arrow hint showing whether higher or lower is "better" for this column
        let dirHint = (col in PROPERTY_DIRECTION) ? (PROPERTY_DIRECTION[col] === "max" ? " ↑" : " ↓") : "";
        g.append("text")
            .attr("class", "pcp-axis-label")
            .attr("y", pcpMargin.top - 20)
            .attr("text-anchor", "middle")
            .style("cursor", "grab")
            .style("font-weight", hasFilter ? "900" : "bold")
            .style("fill", hasFilter ? "#b91c1c" : _pcpAxisRoleColor(col))
            .text(label(col) + dirHint)
            // Dragging this label left/right reorders the axes live
            .call(d3.drag()
                .on("start", function () { d3.select(this.parentNode).raise(); }) // bring the dragged axis to the front visually
                .on("drag", function (event) {
                    let newX = Math.max(pcpMargin.left, Math.min(effectiveWidth - pcpMargin.right, event.x));
                    d3.select(this.parentNode).attr("transform", `translate(${newX},0)`);
                    axisPixelX[col] = newX;
                    // Re-sort the axis order list based on each axis's CURRENT pixel position while dragging
                    currentPcpAxes = currentPcpAxes.slice().sort((a, b) => axisPixelX[a] - axisPixelX[b]);
                })
                .on("end", () => renderChart1(currentPcpAxes, currentPcpFilters)) // snap everything into its final tidy position
            )
            .append("title").text("Drag to reorder this axis"); // native browser tooltip on hover

        // The little ⇕ invert-direction button above each axis
        g.append("text")
            .attr("class", "pcp-invert-btn")
            .attr("y", pcpMargin.top - 34)
            .attr("text-anchor", "middle")
            .style("cursor", "pointer")
            .text("⇕")
            .on("click", () => {
                invertedAxes.has(col) ? invertedAxes.delete(col) : invertedAxes.add(col);
                renderChart1(currentPcpAxes, currentPcpFilters);
            })
            .append("title").text("Invert axis direction");

        // The draggable filter range ("brush") on this axis - drag up/down
        // to select a range of values; anything outside it gets filtered out everywhere
        let brush = d3.brushY()
            .extent([[-14, pcpMargin.top], [14, pcpHeight - pcpMargin.bottom]])
            .on("end", (event) => {
                if (suppressBrushEvents) return; // avoid a feedback loop when WE move the brush programmatically below
                if (!event.selection) {
                    delete currentPcpFilters[col]; // brush cleared -> remove the filter entirely
                } else {
                    let [y0, y1] = event.selection;
                    currentPcpFilters[col] = [y[col].invert(y1), y[col].invert(y0)].sort((a, b) => a - b);
                }
                filterVersion++;
                renderChart1(currentPcpAxes, currentPcpFilters);
                // A filter on this chart affects ALL the other charts too, so refresh them
                if (scatterCtx) renderChart2();
                if (pcaCtx) renderChart3();
                if (heatmapReady) renderChart4();
                if (chart5Ready) renderChart5();
                saveState();
            });

        let brushGroup = g.append("g").attr("class", "brush").call(brush);


        // If this axis already has a filter (e.g. after a redraw), re-draw
        // the brush handle at the right spot without re-triggering the "end" event above
        let activeFilter = currentPcpFilters[col];
        if (activeFilter) {
            let [dataMin, dataMax] = activeFilter;
            let p0 = y[col](dataMin), p1 = y[col](dataMax);
            suppressBrushEvents = true;
            brush.move(brushGroup, [Math.min(p0, p1), Math.max(p0, p1)]);
            suppressBrushEvents = false;


            // Small text under the axis showing the exact numeric range currently selected
            g.append("text")
                .attr("class", "pcp-filter-range")
                .attr("y", pcpHeight - pcpMargin.bottom + 16)
                .attr("text-anchor", "middle")
                .text(`${dataMin.toFixed(2)}–${dataMax.toFixed(2)}`);
        }
    });

    updateStatusBar(); // the counts in the status bar may have changed because of a new filter
}

// Shows the shared dark tooltip box with every visible axis's value for one alloy row
function showPcpTooltip(event, d) {
    let tooltip = d3.select(".tooltip");
    if (tooltip.empty()) tooltip = d3.select("body").append("div").attr("class", "tooltip").style("opacity", 0);
    let rows = currentPcpAxes.map(col => `<b>${label(col)}</b>: ${(+d[col]).toFixed(3)}`).join("<br/>");
    let badges = [];
    if (d.__pareto) badges.push("Pareto-optimal");
    if (pinnedIds.includes(d.__id)) badges.push("Pinned");
    let badgeHtml = badges.length ? `<i>${badges.join(" &middot; ")}</i><br/>` : "";
    tooltip.transition().duration(100).style("opacity", 0.95);
    tooltip.html(`<b>${d.__id}</b><br/>${badgeHtml}${rows}`)
        .style("left", (event.pageX + 12) + "px")
        .style("top", (event.pageY - 20) + "px");
}
function hidePcpTooltip() {
    d3.select(".tooltip").transition().duration(200).style("opacity", 0);
}

// ------------------------------------------------------------------
// renderPcpHoverLine(): draws a bright orange highlight line for whatever
// alloy is currently being hovered in ANY chart (not just this one) - part
// of the cross-chart hover-highlight system in dashboard.js.
// ------------------------------------------------------------------
function renderPcpHoverLine() {
    if (!pcpHoverGroup) return;
    pcpHoverGroup.selectAll("*").remove();
    if (!hoveredId) return;
    let d = alloyById.get(hoveredId);
    if (!d) return;
    let x = pcpXScale();
    let y = pcpYScales();
    let pts = pcpLinePath(d, x, y);
    pcpHoverGroup.append("polyline")
        .attr("points", pts.map(p => p.join(",")).join(" "))
        .attr("fill", "none")
        .attr("stroke", "#ff6b35")
        .attr("stroke-width", 2.5)
        .attr("opacity", 0.9)
        .attr("pointer-events", "none");
}

// Draws the small gradient bar legend (e.g. "Color: Yield Strength" with a
// dark-to-bright bar and its low/high numbers) above the chart
function _renderPcpColorLegend(lo, hi, scale) {
    let legDiv = d3.select("#pcpColorLegend");
    if (legDiv.empty()) return;
    legDiv.html("");

    let lw = 180, lh = 10;
    let svg = legDiv.append("svg").attr("width", lw + 10).attr("height", lh + 32);

    // Build a smooth horizontal gradient by sampling the color scale at many points
    let gradId = "pcpLegGrad";
    let grad = svg.append("defs").append("linearGradient")
        .attr("id", gradId).attr("x1", "0%").attr("x2", "100%");
    d3.range(0, 1.01, 0.05).forEach(t => {
        grad.append("stop")
            .attr("offset", (t * 100) + "%")
            .attr("stop-color", scale(lo + t * (hi - lo)));
    });

    let g = svg.append("g").attr("transform", "translate(0,14)");
    g.append("text")
        .attr("x", 0).attr("y", -3)
        .attr("font-size", "10px").attr("fill", "#555").attr("font-weight", "500")
        .text("Color: " + label(pcpColorBy));
    g.append("rect")
        .attr("width", lw).attr("height", lh)
        .attr("fill", "url(#" + gradId + ")")
        .attr("rx", 2).attr("stroke", "#ccc").attr("stroke-width", 0.5);
    g.append("text")
        .attr("x", 0).attr("y", lh + 12)
        .attr("font-size", "9px").attr("fill", "#666")
        .text(lo.toFixed(1));
    g.append("text")
        .attr("x", lw).attr("y", lh + 12)
        .attr("text-anchor", "end").attr("font-size", "9px").attr("fill", "#666")
        .text(hi.toFixed(1));
}

// Returns the "category color" for a given column name, matching the
// checkbox groups above (used to color axis labels and heatmap labels consistently)
function _pcpAxisRoleColor(col) {
    if (COLUMNS.inputs.includes(col)) return "#2563eb";
    if (COLUMNS.chemistry.includes(col)) return "#16a34a";
    if (typeof MICROSTRUCTURE_AXES !== "undefined" && MICROSTRUCTURE_AXES.includes(col))
        return "#0891b2";
    if (typeof THERMOPHYSICAL_AXES !== "undefined" && THERMOPHYSICAL_AXES.includes(col))
        return "#7c3aed";
    return "#be123c"; // Mechanical Properties
}
