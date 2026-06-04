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

// scatterplot axes
let xAxis, yAxis, xAxisLabel, yAxisLabel;
// radar chart axes
let radarAxes, radarAxesAngle;

let dimensions = [];
// the visual channels we can use for the scatterplot
let channels = ["scatterX", "scatterY", "size"];

// size of the plots
let margin, width, height, radius;
// svg containers
let scatter, radar, dataTable;

// data storage
let parsedData = [];

// selection state
const MAX_SELECTIONS = 7;
const COLOR_PALETTE = [
    "#e41a1c", "#377eb8", "#4daf4a", "#ff7f00",
    "#984ea3", "#a65628", "#f781bf"
];
let selectedItems = []; // array of { id, color, dataRow }
let colorPool = [...COLOR_PALETTE];

// scales (kept in outer scope so renderScatterplot can update them)
let xScale, yScale, sizeScale;

function init() {
    margin = {top: 20, right: 20, bottom: 40, left: 60};
    width = 600;
    height = 500;
    radius = Math.min(width, height) / 2 - 40;

    document.getElementById("defaultOpen").click();

    dataTable = d3.select('#dataTable');

    scatter = d3.select("#sp").append("svg")
        .attr("width", width)
        .attr("height", height)
        .append("g");

    radar = d3.select("#radar").append("svg")
        .attr("width", width)
        .attr("height", height)
        .append("g")
        .attr("transform", "translate(" + (width / 2) + "," + (height / 2) + ")");

    let fileInput = document.getElementById("upload"),
        readFile = function () {
            clear();
            selectedItems = [];
            colorPool = [...COLOR_PALETTE];
            d3.select("#legend").html("<b>Legend:</b><br/>");

            let reader = new FileReader();
            reader.onloadend = function () {
                let rawData = d3.csvParse(reader.result, d3.autoType);

                // First column is the label/name column
                let allKeys = rawData.columns;
                let labelKey = allKeys[0];
                let numericKeys = allKeys.filter(k => k !== labelKey && typeof rawData[0][k] === 'number');

                dimensions = numericKeys;
                parsedData = rawData;

                initVis(parsedData);
                CreateDataTable(parsedData);
                initDashboard(parsedData);
            };
            reader.readAsBinaryString(fileInput.files[0]);
        };
    fileInput.addEventListener('change', readFile);
}

function initVis(_data) {
    if (!_data || _data.length === 0) return;

    let labelKey = _data.columns[0];

    // Build scales with proper domains
    yScale = d3.scaleLinear()
        .domain([
            d3.min(_data, d => +d[dimensions[0]]),
            d3.max(_data, d => +d[dimensions[0]])
        ])
        .range([height - margin.bottom - margin.top, margin.top])
        .nice();

    xScale = d3.scaleLinear()
        .domain([
            d3.min(_data, d => +d[dimensions[0]]),
            d3.max(_data, d => +d[dimensions[0]])
        ])
        .range([margin.left, width - margin.left - margin.right])
        .nice();

    sizeScale = d3.scaleLinear()
        .domain([
            d3.min(_data, d => +d[dimensions[0]]),
            d3.max(_data, d => +d[dimensions[0]])
        ])
        .range([3, 20]);

    // Y axis
    yAxis = scatter.append("g")
        .attr("class", "axis")
        .attr("transform", "translate(" + margin.left + ",0)")
        .call(d3.axisLeft(yScale));

    yAxisLabel = scatter.append("text")
        .attr("class", "axis-label")
        .attr("transform", "rotate(-90)")
        .attr("x", -(height / 2))
        .attr("y", 15)
        .attr("text-anchor", "middle")
        .style("font-size", "12px")
        .text(dimensions[0]);

    // X axis
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

    // Radar chart axes
    radarAxesAngle = (Math.PI * 2) / dimensions.length;
    let axisRadius = d3.scaleLinear().range([0, radius]);
    let maxAxisRadius = 0.75;
    let textRadius = 0.85;
    let gridRadius = 0.1;

    // Draw grid circles (gray)
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

    // Radar axes
    radarAxes = radar.selectAll(".axis")
        .data(dimensions)
        .enter()
        .append("g")
        .attr("class", "axis");

    radarAxes.append("line")
        .attr("x1", 0).attr("y1", 0)
        .attr("x2", (d, i) => radarX(axisRadius(maxAxisRadius), i))
        .attr("y2", (d, i) => radarY(axisRadius(maxAxisRadius), i))
        .attr("class", "line")
        .style("stroke", "black");

    // Axis labels
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

    // Init menus
    channels.forEach(c => initMenu(c, dimensions));
    channels.forEach(c => refreshMenu(c));

    renderScatterplot();
    renderRadarChart();
}

function clear() {
    scatter.selectAll("*").remove();
    radar.selectAll("*").remove();
    dataTable.selectAll("*").remove();
}

function CreateDataTable(_data) {
    if (!_data || _data.length === 0) return;

    let allKeys = _data.columns;

    // Create tooltip
    let tooltip = d3.select("body").select(".tooltip");
    if (tooltip.empty()) {
        tooltip = d3.select("body").append("div").attr("class", "tooltip").style("opacity", 0);
    }

    let table = dataTable.append("table").attr("class", "dataTableClass");

    // Header
    let thead = table.append("thead");
    let headerRow = thead.append("tr");
    headerRow.selectAll("th")
        .data(allKeys)
        .enter()
        .append("th")
        .attr("class", "tableHeaderClass")
        .text(d => d.toUpperCase());

    // Body
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
        .text(d => d.value);

    // Hover highlight
    rows.on("mouseover", function () {
            d3.select(this).style("background-color", "#d0e8ff");
        })
        .on("mouseout", function () {
            d3.select(this).style("background-color", null);
        });
}

function renderScatterplot() {
    if (!parsedData || parsedData.length === 0) return;

    let xDim = readMenu("scatterX");
    let yDim = readMenu("scatterY");
    let sizeDim = readMenu("size");

    // Update scales
    xScale.domain([
        d3.min(parsedData, d => +d[xDim]),
        d3.max(parsedData, d => +d[xDim])
    ]).nice();

    yScale.domain([
        d3.min(parsedData, d => +d[yDim]),
        d3.max(parsedData, d => +d[yDim])
    ]).nice();

    sizeScale = d3.scaleLinear()
        .domain([
            d3.min(parsedData, d => +d[sizeDim]),
            d3.max(parsedData, d => +d[sizeDim])
        ])
        .range([3, 20]);

    let t = d3.transition().duration(600).ease(d3.easeCubicInOut);

    // Animate axes
    xAxis.transition(t).call(d3.axisBottom(xScale));
    yAxis.transition(t).call(d3.axisLeft(yScale));

    // Update axis labels
    xAxisLabel.text(xDim);
    yAxisLabel.text(yDim);

    // Tooltip
    let tooltip = d3.select(".tooltip");
    if (tooltip.empty()) {
        tooltip = d3.select("body").append("div").attr("class", "tooltip").style("opacity", 0);
    }

    let labelKey = parsedData.columns[0];

    // Bind data to dots
    let dots = scatter.selectAll(".dot")
        .data(parsedData, d => d[labelKey]);

    // Enter
    let dotsEnter = dots.enter()
        .append("circle")
        .attr("class", "dot")
        .attr("cx", d => xScale(+d[xDim]))
        .attr("cy", d => yScale(+d[yDim]))
        .attr("r", d => sizeScale(+d[sizeDim]))
        .style("fill", d => getItemColor(d[labelKey]))
        .style("opacity", 0.65)
        .style("stroke", d => isSelected(d[labelKey]) ? "#000" : "none")
        .style("stroke-width", 1.5);

    // Merge + transition
    dots.merge(dotsEnter)
        .on("click", function (event, d) {
            toggleSelection(d);
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
        .style("fill", d => getItemColor(d[labelKey]))
        .style("stroke", d => isSelected(d[labelKey]) ? "#000" : "none");

    dots.exit().remove();
}

function getItemColor(label) {
    let sel = selectedItems.find(s => s.id === label);
    return sel ? sel.color : "#777";
}

function isSelected(label) {
    return selectedItems.some(s => s.id === label);
}

function toggleSelection(d) {
    let labelKey = parsedData.columns[0];
    let label = d[labelKey];

    if (isSelected(label)) {
        // Deselect
        deselectItem(label);
    } else {
        if (selectedItems.length >= MAX_SELECTIONS) return;
        // pick next available color
        let color = colorPool.find(c => !selectedItems.some(s => s.color === c));
        if (!color) return;
        selectedItems.push({ id: label, color: color, dataRow: d });
        updateLegend();
        renderScatterplot();
        renderRadarChart();
    }
}

function deselectItem(label) {
    selectedItems = selectedItems.filter(s => s.id !== label);
    updateLegend();
    renderScatterplot();
    renderRadarChart();
}

function updateLegend() {
    let legend = d3.select("#legend");
    legend.html("<b>Legend:</b><br/>");

    selectedItems.forEach(item => {
        let entry = legend.append("div").style("display", "flex").style("align-items", "center").style("margin", "4px 0");
        entry.append("span")
            .attr("class", "color-circle")
            .style("background-color", item.color)
            .style("margin-right", "6px");
        entry.append("span").text(item.id).style("flex", "1");
        entry.append("span")
            .attr("class", "close")
            .text("×")
            .on("click", () => deselectItem(item.id));
    });
}

function renderRadarChart() {
    // Remove existing polylines and dots
    radar.selectAll(".radarLine").remove();
    radar.selectAll(".radarDot").remove();

    if (!parsedData || parsedData.length === 0 || dimensions.length === 0) return;

    // Build per-dimension scales
    let dimScales = {};
    dimensions.forEach(dim => {
        dimScales[dim] = d3.scaleLinear()
            .domain([0, d3.max(parsedData, d => +d[dim])])
            .range([0, radius * 0.75]);
    });

    selectedItems.forEach(item => {
        let d = item.dataRow;
        // Compute polygon points
        let points = dimensions.map((dim, i) => {
            let r = dimScales[dim](+d[dim]);
            return [radarX(r, i), radarY(r, i)];
        });

        radar.append("polygon")
            .attr("class", "radarLine")
            .attr("points", points.map(p => p.join(",")).join(" "))
            .attr("fill", item.color)
            .attr("fill-opacity", 0.15)
            .attr("stroke", item.color)
            .attr("stroke-width", 2);

        // Dots at each vertex
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

function radarX(r, index) { return r * Math.cos(radarAngle(index)); }
function radarY(r, index) { return r * Math.sin(radarAngle(index)); }
function radarAngle(index) { return radarAxesAngle * index - Math.PI / 2; }

function initMenu(id, entries) {
    $("select#" + id).empty();
    entries.forEach(d => $("select#" + id).append("<option>" + d + "</option>"));
    $("#" + id).selectmenu({
        select: function () { renderScatterplot(); }
    });
}

function refreshMenu(id) { $("#" + id).selectmenu("refresh"); }
function readMenu(id) { return $("#" + id).val(); }

function openPage(pageName, elmnt, color) {
    var i, tabcontent, tablinks;
    tabcontent = document.getElementsByClassName("tabcontent");
    for (i = 0; i < tabcontent.length; i++) tabcontent[i].style.display = "none";
    tablinks = document.getElementsByClassName("tablink");
    for (i = 0; i < tablinks.length; i++) tablinks[i].style.backgroundColor = "";
    document.getElementById(pageName).style.display = "block";
    elmnt.style.backgroundColor = color;
}
