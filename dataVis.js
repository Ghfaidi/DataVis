/*
* Data Visualization - Framework
* Copyright (C) University of Passau
*   Faculty of Computer Science and Mathematics
*   Chair of Cognitive sensor systems
* Maintenance:
*   2025, Alexander Gall <alexander.gall@uni-passau.de>
*
* All rights reserved.
*/

/*

This is the "Part 1" code: it handles
  1. Reading the file the user uploads
  2. Showing that data as a plain table
  3. Drawing a simple scatterplot (dots on x/y axes)
  4. Drawing a radar/spider chart
  5. Letting you click a dot to "select" it (up to 5 at once) and see it
     highlighted with its own color + shown on the radar chart
  6. Switching between the 3 tabs at the top of the page

If you're looking for the big 5-chart Dashboard tab instead, that logic
lives in dashboard.js and the chart1-5 files - this file is only the
simpler "warm-up" visualization.

d3 (the "d3.select(...)", "d3.scaleLinear()" etc. calls) is a JavaScript
library for drawing charts. Instead of manually calculating pixel positions
everywhere, it gives us handy tools like "scales" (convert a data value
into a pixel position) and "selections" (find/create/update HTML or SVG
elements).
*/

// ------------------------------------------------------------------
// SHARED "BOXES" (variables) used across many functions below.
// Declaring them here means every function in this file can read/change
// them, instead of having to pass them around as arguments everywhere.
// ------------------------------------------------------------------

// scatterplot axes (the drawn axis lines + their text labels)
let xAxis, yAxis, xAxisLabel, yAxisLabel;
// radar chart axes (one line per data column, radiating from the center)
let radarAxes, radarAxesAngle;

// the list of numeric column names found in the uploaded file
let dimensions = [];
// the visual channels we can use for the scatterplot - matches the 3 <select> dropdowns in index.html
let channels = ["scatterX", "scatterY", "size"];

// size of the plots (in pixels)
let margin, width, height, radius;
// svg containers: the <g> group elements we draw everything inside
let scatter, radar, dataTable;

// data storage: every row from the uploaded file, after parsing
let parsedData = [];

// selection state: which dots the user has clicked on
const MAX_SELECTIONS = 5;
const COLOR_PALETTE = [
    "#e41a1c", "#377eb8", "#4daf4a", "#ff7f00",
    "#984ea3", "#a65628", "#f781bf"
];
let selectedItems = []; // array of { id, label, color, dataRow } -- id is the row INDEX, not the row's label value (fixes selection breaking when two rows share the same first-column value, e.g. the many alloy rows with KS1295[%] == 0)
let colorPool = [...COLOR_PALETTE]; // colors not currently used by a selection

// scales (kept in outer scope so renderScatterplot can update them)
// A "scale" is just a little converter function: give it a data value (like
// "350 MPa") and it hands back a pixel position (like "212px") so we know
// where on screen to draw the dot.
let xScale, yScale, sizeScale;

function CreateSummaryTable(_data) {
    if (!_data || _data.length === 0) return;

    let allKeys = _data.columns;
    let labelKey = allKeys[0];
    let numericKeys = allKeys.filter(k => k !== labelKey && typeof _data[0][k] === 'number');

    // 1. Calculate the summary statistics for each numeric variable
    let summaryData = numericKeys.map(key => {
        let values = _data.map(d => +d[key]).filter(v => !isNaN(v) && v !== null);
        return {
            variable: key,
            mean: d3.mean(values),
            variance: d3.variance(values),
            min: d3.min(values),
            max: d3.max(values)
        };
    });

    // 2. Build the summary table structure
    let container = d3.select('#dataTable');
    container.append("h3")
        .text("Variable Summary Statistics")
        .style("margin-top", "20px");

    let table = container.append("table")
        .attr("class", "dataTableClass")
        .style("margin-bottom", "30px");

    // Header row
    let headers = ["Variable", "Mean", "Variance", "Min", "Max"];
    table.append("thead")
        .append("tr")
        .selectAll("th")
        .data(headers)
        .enter()
        .append("th")
        .attr("class", "tableHeaderClass")
        .text(d => d.toUpperCase());

    // Populate data rows
    let tbody = table.append("tbody");
    summaryData.forEach(row => {
        let tr = tbody.append("tr");
        
        tr.append("td").attr("class", "tableBodyClass").style("font-weight", "500").text(row.variable);
        tr.append("td").attr("class", "tableBodyClass").text(row.mean !== undefined ? row.mean.toFixed(4) : "N/A");
        tr.append("td").attr("class", "tableBodyClass").text(row.variance !== undefined ? row.variance.toFixed(4) : "N/A");
        tr.append("td").attr("class", "tableBodyClass").text(row.min !== undefined ? row.min.toFixed(4) : "N/A");
        tr.append("td").attr("class", "tableBodyClass").text(row.max !== undefined ? row.max.toFixed(4) : "N/A");
    });
}

// ------------------------------------------------------------------
// init() runs once, right when the page finishes loading (see the
// <script>document.addEventListener('DOMContentLoaded', init);</script>
// line at the bottom of index.html). It sets up the empty chart areas and
// starts listening for a file to be picked.
// ------------------------------------------------------------------
function init() {
    // How much empty space to leave around the chart, and how big to draw it
    margin = { top: 20, right: 20, bottom: 40, left: 60 };
    width = 600;
    height = 500;
    radius = Math.min(width, height) / 2 - 40;

    // Simulate a click on the first tab button, so "Data Loading" is open by default
    document.getElementById("defaultOpen").click();

    // Grab the empty <div id="dataTable"> from the HTML so we can fill it in later
    dataTable = d3.select('#dataTable');

    // Create an empty SVG canvas inside <div id="sp"> for the scatterplot,
    // and grab a <g> (group) element inside it that we'll draw shapes into
    scatter = d3.select("#sp").append("svg")
        .attr("width", width)
        .attr("height", height)
        .append("g");

    // Same idea for the radar chart, except we shift ("translate") its <g>
    // so that (0,0) becomes the CENTER of the SVG instead of the top-left
    // corner - that makes the radar-chart math (angles/circles) much simpler.
    radar = d3.select("#radar").append("svg")
        .attr("width", width)
        .attr("height", height)
        .append("g")
        .attr("transform", "translate(" + (width / 2) + "," + (height / 2) + ")");

    // Grab the <input type="file"> element from the HTML
    let fileInput = document.getElementById("upload"),
        // This function runs whenever the user picks a new file
        readFile = function () {
            // Wipe out anything drawn from a previous file, and reset selections
            clear();
            selectedItems = [];
            colorPool = [...COLOR_PALETTE];
            d3.select("#legend").html("<b>Legend:</b><br/>");

            // FileReader is a built-in browser tool for reading the contents
            // of a file the user picked, without uploading it anywhere.
            let reader = new FileReader();
            // This runs once the browser has finished reading the file into memory
            reader.onloadend = function () {
                let text = reader.result; // the raw text content of the file

                // Figure out whether the file uses commas (.csv) or tabs (.tsv)
                // by checking the very first line for a tab character.
                let firstLine = text.split(/\r?\n/)[0];
                let delimiter = firstLine.includes("\t") ? "\t" : ",";
                // d3.dsvFormat parses the raw text into an array of row objects.
                // d3.autoType automatically converts things that look like
                // numbers into real JavaScript numbers (instead of leaving
                // everything as text).
                let rawData = d3.dsvFormat(delimiter).parse(text, d3.autoType);

                // Drop any blank/empty column names (can happen with trailing commas/tabs)
                rawData.columns = rawData.columns.filter(c => c && c.trim() !== "");

                let allKeys = rawData.columns;
                let labelKey = allKeys[0]; // we treat the FIRST column as the "name" of each row
                // Every OTHER column that actually holds numbers counts as a "dimension"
                // (something we could plot on an axis)
                let numericKeys = allKeys.filter(k => k !== labelKey && typeof rawData[0][k] === 'number');

                dimensions = numericKeys;
                parsedData = rawData;

                // Big files would make this simple Part-1 view painfully slow
                // (drawing thousands of SVG dots/table rows), so above a
                // certain size we just show a small preview here and point
                // the user to the proper Dashboard tab instead.
                const LARGE_DATASET_THRESHOLD = 5000;
                if (parsedData.length > LARGE_DATASET_THRESHOLD) {
                    dataTable.html(
                        `<p><i>${parsedData.length.toLocaleString()} rows loaded &mdash; too large for the ` +
                        `Part 1 table/scatterplot view (showing the first 200 rows as a preview only). ` +
                        `Open the <b>Dashboard</b> tab for the full Part 2 visualization.</i></p>`
                    );
                    let preview = parsedData.slice(0, 200);
                    preview.columns = parsedData.columns;
                    CreateSummaryTable(parsedData);
                    CreateDataTable(preview);
                    
                    d3.select("#sp").html("<p><i>Skipped for large dataset &mdash; see Dashboard tab.</i></p>");
                    d3.select("#radar").html("");
                } else {
                    // Small enough - build the real scatterplot/radar chart + full table
                    initVis(parsedData);
                    CreateSummaryTable(parsedData);
                    CreateDataTable(parsedData);
                    
                }

                // Show loading state so the user knows the dashboard is computing
                d3.select("#chart3").html("<p class='loading-msg'>&#9203; Computing PCA&hellip; this may take a few seconds for large datasets.</p>");
                d3.select("#dashboardStatus").text("Processing dataset…");

                // Defer to let the DOM render the loading message before the synchronous computation blocks
                // (setTimeout with a tiny delay lets the browser repaint the
                // "Computing PCA..." message BEFORE we lock up the page doing
                // the heavy Part 2 number-crunching in initDashboard)
                setTimeout(() => { initDashboard(parsedData); }, 16);
            };
            // Kick off the actual file read (this triggers reader.onloadend above once it's done)
            reader.readAsText(fileInput.files[0]);
        };
    // Whenever the file <input> changes (user picked a new file), run readFile
    fileInput.addEventListener('change', readFile);
}

// ------------------------------------------------------------------
// initVis() builds the scatterplot axes and the radar chart's spokes/grid
// for the very first time after a new file is loaded. It only runs ONCE
// per file - after this, renderScatterplot()/renderRadarChart() handle
// updates (e.g. when the user changes a dropdown or clicks a dot).
// ------------------------------------------------------------------
function initVis(_data) {
    if (!_data || _data.length === 0) return; // nothing to draw if the file was empty

    let labelKey = _data.columns[0];

    // Set up the y-axis scale: smallest value in the first dimension maps
    // to the bottom of the chart, largest maps to the top (note range is
    // "flipped" because pixel y=0 is the TOP of the screen, not the bottom).
    yScale = d3.scaleLinear()
        .domain([
            d3.min(_data, d => +d[dimensions[0]]),
            d3.max(_data, d => +d[dimensions[0]])
        ])
        .range([height - margin.bottom - margin.top, margin.top]);

    xScale = d3.scaleLinear()
        .domain([
            d3.min(_data, d => +d[dimensions[0]]),
            d3.max(_data, d => +d[dimensions[0]])
        ])
        .range([margin.left, width - margin.left - margin.right]);

    // sizeScale converts a data value into a dot radius, from 3px (small) up to 20px (big)
    sizeScale = d3.scaleLinear()
        .domain([
            d3.min(_data, d => +d[dimensions[0]]),
            d3.max(_data, d => +d[dimensions[0]])
        ])
        .range([3, 20]);

    // Y axis: draw the vertical axis line + tick marks, and its text label
    yAxis = scatter.append("g")
        .attr("class", "axis")
        .attr("transform", "translate(" + margin.left + ",0)")
        .call(d3.axisLeft(yScale));

    yAxisLabel = scatter.append("text")
        .attr("class", "axis-label")
        .attr("transform", "rotate(-90)") // sideways text, reads bottom-to-top
        .attr("x", -(height / 2))
        .attr("y", 15)
        .attr("text-anchor", "middle")
        .style("font-size", "12px")
        .text(dimensions[0]);

    // X axis: same idea, but the horizontal axis line at the bottom
    xAxis = scatter.append("g")
        .attr("class", "axis")
        .attr("transform", "translate(0," + (height - margin.bottom - margin.top) + ")")
        .call(d3.axisBottom(xScale));

    xAxisLabel = scatter.append("text")
        .attr("class", "axis-label")
        .attr("x", width / 2)
        .attr("y", height - margin.top)
        .attr("text-anchor", "middle")
        .style("font-size", "12px")
        .text(dimensions[0]);

    // ---- Radar chart axes ----
    // A radar chart has one "spoke" per dimension, evenly spaced in a full
    // circle. radarAxesAngle is how many radians apart each spoke sits.
    radarAxesAngle = (Math.PI * 2) / dimensions.length;
    let axisRadius = d3.scaleLinear().range([0, radius]); // converts 0-1 into an actual pixel radius
    let maxAxisRadius = 0.75; // spokes only reach 75% of the way to the edge (leaves room for labels)
    let textRadius = 0.85;    // labels sit a bit further out than the spokes
    let gridRadius = 0.1;

    // Draw grid circles (gray)
    // These are the faint gray "web" rings you see behind a radar chart,
    // drawn as polygons (straight lines between spokes) rather than true
    // circles, at 5 evenly-spaced distances from the center.
    let gridLevels = 5;
    for (let level = 1; level <= gridLevels; level++) {
        let r = axisRadius(maxAxisRadius * level / gridLevels);
        // Build polygon points for grid
        let points = dimensions.map((d, i) => {
            let angle = radarAngle(i);
            return [r * Math.cos(angle), r * Math.sin(angle)];
        });
        radar.append("polygon")
            .attr("points", points.map(p => p.join(",")).join(" "))
            .attr("fill", "none")
            .attr("stroke", "#ccc")
            .attr("stroke-width", 0.8);
    }

    // Radar axes: one straight line ("spoke") per dimension, going from the
    // center out to the edge. d3's .data(dimensions).enter() pattern means
    // "for each dimension, create one new <g> element".
    radarAxes = radar.selectAll(".axis")
        .data(dimensions)
        .enter()
        .append("g")
        .attr("class", "axis");

    radarAxes.append("line")
        .attr("x1", 0).attr("y1", 0) // every spoke starts at the center
        .attr("x2", (d, i) => radarX(axisRadius(maxAxisRadius), i))
        .attr("y2", (d, i) => radarY(axisRadius(maxAxisRadius), i))
        .attr("class", "line")
        .style("stroke", "black");

    // Axis labels: the dimension name printed at the tip of each spoke
    radar.selectAll(".axisLabel")
        .data(dimensions)
        .enter()
        .append("text")
        .attr("class", "axisLabel")
        .attr("text-anchor", "middle")
        .attr("dy", "0.35em")
        .attr("x", (d, i) => radarX(axisRadius(textRadius), i))
        .attr("y", (d, i) => radarY(axisRadius(textRadius), i))
        .style("font-size", "11px")
        .text(d => d);

    // Fill the 3 dropdown menus (x axis / y axis / size) with the available dimensions
    channels.forEach(c => initMenu(c, dimensions));
    channels.forEach(c => refreshMenu(c));

    // Now actually draw the dots and the radar shapes for the first time
    renderScatterplot();
    renderRadarChart();
}

// Wipes everything drawn so far, so we can start fresh with a new file
function clear() {
    scatter.selectAll("*").remove();
    radar.selectAll("*").remove();
    dataTable.selectAll("*").remove();
}

// ------------------------------------------------------------------
// CreateDataTable() builds a plain HTML <table> showing every row/column
// of the uploaded data, for the "Data Loading" tab.
// ------------------------------------------------------------------
function CreateDataTable(_data) {
    if (!_data || _data.length === 0) return;
    //CreateSummaryTable(_data);
    let allKeys = _data.columns;

    // Create tooltip (the little dark popup box) if it doesn't exist yet -
    // shared across the whole page rather than making a new one every time
    let tooltip = d3.select("body").select(".tooltip");
    if (tooltip.empty()) {
        tooltip = d3.select("body").append("div").attr("class", "tooltip").style("opacity", 0);
    }

    let table = dataTable.append("table").attr("class", "dataTableClass");

    // Header: one <th> cell per column name, shown in UPPERCASE (styled via CSS)
    let thead = table.append("thead");
    let headerRow = thead.append("tr");
    headerRow.selectAll("th")
        .data(allKeys)
        .enter()
        .append("th")
        .attr("class", "tableHeaderClass")
        .text(d => d.toUpperCase());

    // Body: one <tr> per data row, and inside each row one <td> per column value
    let tbody = table.append("tbody");
    let rows = tbody.selectAll("tr")
        .data(_data)
        .enter()
        .append("tr");

    rows.selectAll("td")
        .data(row => allKeys.map(k => ({ key: k, value: row[k] })))
        .enter()
        .append("td")
        .attr("class", "tableBodyClass")
        .text(d => d.value)
        // Highlight just the cell under the mouse (handled again via CSS
        // :hover too, but this JS version lets us control it precisely)
        .on("mouseover", function () {
            d3.select(this).style("background-color", "#d0e8ff");
        })
        .on("mouseout", function () {
            d3.select(this).style("background-color", null);
        });
}

// ------------------------------------------------------------------
// renderScatterplot() (re)draws the dots on the scatterplot, based on
// whatever the user has chosen in the x/y/size dropdown menus. It's called
// both the first time (from initVis) and every time a dropdown changes.
// ------------------------------------------------------------------
function renderScatterplot() {
    if (!parsedData || parsedData.length === 0) return;

    // Read the currently-selected column name from each of the 3 dropdowns
    let xDim = readMenu("scatterX");
    let yDim = readMenu("scatterY");
    let sizeDim = readMenu("size");

    // Update scales so their domain (min/max of the data) matches
    // whichever column is now selected
    xScale.domain([
        d3.min(parsedData, d => +d[xDim]),
        d3.max(parsedData, d => +d[xDim])
    ]);

    yScale.domain([
        d3.min(parsedData, d => +d[yDim]),
        d3.max(parsedData, d => +d[yDim])
    ]);

    sizeScale = d3.scaleLinear()
        .domain([
            d3.min(parsedData, d => +d[sizeDim]),
            d3.max(parsedData, d => +d[sizeDim])
        ])
        .range([3, 20]);

    // A "transition" makes changes animate smoothly instead of jumping instantly
    let t = d3.transition().duration(600).ease(d3.easeCubicInOut);

    // Animate the axes sliding to their new scale
    xAxis.transition(t).call(d3.axisBottom(xScale));
    yAxis.transition(t).call(d3.axisLeft(yScale));

    // Update the text labels under/beside the axes to match the new columns
    xAxisLabel.text(xDim);
    yAxisLabel.text(yDim);

    // Tooltip (reuse the shared one, or create it if this is the very first chart)
    let tooltip = d3.select(".tooltip");
    if (tooltip.empty()) {
        tooltip = d3.select("body").append("div").attr("class", "tooltip").style("opacity", 0);
    }

    // This is the standard d3 "enter/update/exit" pattern:
    // - dots that don't exist yet get created ("enter")
    // - dots that already exist just get their attributes updated ("merge")
    // - dots no longer in the data get removed ("exit")
    let dots = scatter.selectAll(".dot")
        .data(parsedData, (d, i) => i);

    // Enter: brand new circles, placed immediately (no animation) at their starting spot
    let dotsEnter = dots.enter()
        .append("circle")
        .attr("class", "dot")
        .attr("cx", d => xScale(+d[xDim]))
        .attr("cy", d => yScale(+d[yDim]))
        .attr("r", d => sizeScale(+d[sizeDim]))
        .style("fill", (d, i) => getItemColor(i))
        .style("opacity", 0.65)
        .style("stroke", (d, i) => isSelected(i) ? "#000" : "none")
        .style("stroke-width", 1.5);

    // Merge + transition: both new and existing dots get their click/hover
    // behavior (re)attached, then animate to their new position/size/color
    dots.merge(dotsEnter)
        .on("click", function (event, d) {
            let i = parsedData.indexOf(d);
            toggleSelection(d, i);
        })
        .on("mouseover", function (event, d) {
            tooltip.transition().duration(100).style("opacity", 0.95);
            let tipContent = Object.entries(d)
                .map(([k, v]) => `<b>${k}</b>: ${v}`)
                .join("<br/>");
            tooltip.html(tipContent)
                .style("left", (event.pageX + 10) + "px")
                .style("top", (event.pageY - 20) + "px");
        })
        .on("mouseout", function () {
            tooltip.transition().duration(200).style("opacity", 0);
        })
        .transition(t)
        .attr("cx", d => xScale(+d[xDim]))
        .attr("cy", d => yScale(+d[yDim]))
        .attr("r", d => sizeScale(+d[sizeDim]))
        .style("fill", (d, i) => getItemColor(i))
        .style("stroke", (d, i) => isSelected(i) ? "#000" : "none");

    // Exit: remove any leftover dots that no longer have matching data
    dots.exit().remove();
}

// Returns the color a dot should be: its selection color if it's selected, otherwise plain gray
function getItemColor(i) {
    let sel = selectedItems.find(s => s.id === i);
    return sel ? sel.color : "#777";
}

// Is row index i currently one of the selected (clicked) items?
function isSelected(i) {
    return selectedItems.some(s => s.id === i);
}

// ------------------------------------------------------------------
// Clicking a dot calls this: if it's already selected, unselect it.
// Otherwise, try to select it (up to MAX_SELECTIONS = 5 at once).
// ------------------------------------------------------------------
function toggleSelection(d, i) {
    if (isSelected(i)) {
        // Deselect
        deselectItem(i);
    } else {
        if (selectedItems.length >= MAX_SELECTIONS) return; // already at the limit, do nothing
        // pick next available color from the pool that isn't already in use
        let color = colorPool.find(c => !selectedItems.some(s => s.color === c));
        if (!color) return;
        selectedItems.push({ id: i, label: d[parsedData.columns[0]], color: color, dataRow: d });
        updateLegend();
        renderScatterplot();
        renderRadarChart();
    }
}

// Removes item at row index i from the selection, then redraws everything that depends on it
function deselectItem(i) {
    selectedItems = selectedItems.filter(s => s.id !== i);
    updateLegend();
    renderScatterplot();
    renderRadarChart();
}

// ------------------------------------------------------------------
// Rebuilds the little legend box next to the radar chart, listing each
// selected item's color, name, and an "×" button to remove it.
// ------------------------------------------------------------------
function updateLegend() {
    let legend = d3.select("#legend");
    legend.html("<b>Legend:</b><br/>");

    selectedItems.forEach(item => {
        let entry = legend.append("div")
            .style("display", "flex")
            .style("align-items", "center")
            .style("margin", "4px 0");
        entry.append("span")
            .attr("class", "color-circle")
            .style("background-color", item.color)
            .style("margin-right", "6px");
        entry.append("span")
            .text(item.label)
            .style("flex", "1")
            .style("margin-right", "8px");
        entry.append("span")
            .attr("class", "close")
            .attr("title", "Remove")
            .attr("onclick", `deselectItem(${item.id})`) // calls deselectItem() directly when clicked
            .text("×");
    });
}

// ------------------------------------------------------------------
// renderRadarChart() draws one polygon shape per selected item, showing
// how its values compare across all dimensions at once.
// ------------------------------------------------------------------
function renderRadarChart() {
    // Remove existing polylines and dots (we redraw everything from scratch each time)
    radar.selectAll(".radarLine").remove();
    radar.selectAll(".radarDot").remove();

    if (!parsedData || parsedData.length === 0 || dimensions.length === 0) return;


    // Build one scale per dimension: converts that column's min/max value
    // into a distance from the center (0 = center, radius*0.75 = edge)
    let dimScales = {};
    dimensions.forEach(dim => {
        dimScales[dim] = d3.scaleLinear()
            .domain([d3.min(parsedData, d => +d[dim]), d3.max(parsedData, d => +d[dim])])
            .range([0, radius * 0.75]);
    });

    selectedItems.forEach(item => {
        let d = item.dataRow;
        // Compute polygon points: one (x,y) point per dimension/spoke
        let points = dimensions.map((dim, i) => {
            let r = dimScales[dim](+d[dim]);
            return [radarX(r, i), radarY(r, i)];
        });

        // Draw the outline connecting all those points - this is the
        // "spider web" shape you see per selected item
        radar.append("polygon")
            .attr("class", "radarLine")
            .attr("points", points.map(p => p.join(",")).join(" "))
            .attr("fill", "none")
            .attr("stroke", item.color)
            .attr("stroke-width", 2);

        // Dots at each vertex (one little circle at each corner of the polygon)
        dimensions.forEach((dim, i) => {
            let r = dimScales[dim](+d[dim]);
            radar.append("circle")
                .attr("class", "radarDot")
                .attr("cx", radarX(r, i))
                .attr("cy", radarY(r, i))
                .attr("r", 4)
                .attr("fill", item.color)
                .attr("stroke", "#fff")
                .attr("stroke-width", 1);
        });
    });
}

// Small trig helpers: convert a distance-from-center (r) and a spoke index
// into actual x/y pixel coordinates, using the angle for that spoke.
function radarX(r, index) { return r * Math.cos(radarAngle(index)); }
function radarY(r, index) { return r * Math.sin(radarAngle(index)); }
// The angle for spoke number `index` - the "- Math.PI / 2" just rotates
// everything so the first spoke points straight up instead of straight right.
function radarAngle(index) { return radarAxesAngle * index - Math.PI / 2; }

// ------------------------------------------------------------------
// Small helpers for working with the jQuery UI dropdown ("selectmenu") widgets
// ------------------------------------------------------------------

// Fills a <select id="..."> with one <option> per entry, then turns it
// into a styled jQuery UI dropdown. Whenever the user picks a new option,
// re-draw the scatterplot.
function initMenu(id, entries) {
    $("select#" + id).empty();
    entries.forEach(d => $("select#" + id).append("<option>" + d + "</option>"));
    $("#" + id).selectmenu({
        select: function () { renderScatterplot(); }
    });
}

// Tells the jQuery UI widget to redraw itself (needed after changing the underlying <select> in code)
function refreshMenu(id) { $("#" + id).selectmenu("refresh"); }
// Reads the currently-chosen value out of a dropdown
function readMenu(id) { return $("#" + id).val(); }

// ------------------------------------------------------------------
// openPage() handles the 3 tab buttons at the top of the page (Data
// Loading / Basic Visualization / Dashboard). It's called directly from
// the onclick="..." attributes in index.html.
// ------------------------------------------------------------------
function openPage(pageName, elmnt, color) {
    var i, tabcontent, tablinks;
    // Hide every tab's content...
    tabcontent = document.getElementsByClassName("tabcontent");
    for (i = 0; i < tabcontent.length; i++) tabcontent[i].style.display = "none";
    // ...and reset every tab button's background color...
    tablinks = document.getElementsByClassName("tablink");
    for (i = 0; i < tablinks.length; i++) tablinks[i].style.backgroundColor = "";
    // ...then show only the tab that was clicked, and color its button
    document.getElementById(pageName).style.display = "block";
    elmnt.style.backgroundColor = color;
    // If the dashboard has already loaded data, remember the current
    // dashboard settings (pinned alloys, chosen axes, etc.) in the browser's
    // local storage, so they survive a page refresh (see saveState() in
    // dashboard.js)
    if (typeof saveState === 'function' && typeof alloyData !== 'undefined' && alloyData.length > 0) {
        saveState();
    }
}
