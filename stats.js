// Group 05 · Meriam Ferjani, Ghofrane Faidi

/*
============================================================
WHAT IS THIS FILE?
============================================================
Think of this file as the "math toolbox" for the dashboard. It doesn't
draw anything on screen by itself - instead, it has a bunch of functions
that do calculations, and the chart files (chart1-pcp.js, chart3-pca.js,
chart4-heatmap.js, etc.) call these functions to get numbers they can then
draw.

It's organized into a few topics:
  1. Cleaning / missing values  -> fixing gaps or weird text in the data
  2. Standardization            -> putting all columns on the same scale
  3. PCA                        -> squashing many columns down to 2 (for chart3)
  4. Pareto front               -> finding the "best" alloys (for chart1/chart2)
  5. Correlation                -> how strongly two columns move together (for chart4)
  6. Weighted score             -> combining several columns into one score (for chart3)

You don't need to fully understand the math to use this file - just know
WHAT each function gives you back, and roughly WHY it's needed.
*/

// ============================================================
// 1. Cleaning / missing values
// ============================================================

// The alloy CSV encodes unconverged/non-forming phases as "NaN" for some output columns. d3.autoType does not recognize that token, so it comes as the literal string "NaN". This normalizes any such token to null.
// In plain words: some cells in the file just say the TEXT "NaN" (meaning
// "no value"), but JavaScript doesn't automatically understand that's not
// a real number. This function looks at one cell and decides: is this
// actually a usable number, or should we treat it as "missing" (null)?
function toNumericOrNull(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === "number") return isNaN(v) ? null : v;
    let s = String(v).trim().toLowerCase();
    if (s === "" || s === "nan" || s === "na" || s === "-" || s === "null") return null;
    let n = +v; // try to convert the text to a number
    return isNaN(n) ? null : n;
}

// ------------------------------------------------------------------
// imputeMean(): for a list of columns, fill in any missing (null) cells
// with the AVERAGE of that column (computed only from the rows that DO
// have a value). "Impute" just means "fill in a reasonable guess for a
// missing value" - it's a common trick so that later math (like PCA or
// correlation) doesn't break when some cells are empty.
// ------------------------------------------------------------------
function imputeMean(data, cols) {
    let means = {};
    // Step 1: work out the average for each column, ignoring missing cells
    cols.forEach(col => {
        let sum = 0, count = 0;
        data.forEach(row => {
            let v = toNumericOrNull(row[col]);
            row[col] = v; // normalize: number or null
            if (v !== null) { sum += v; count++; }
        });
        means[col] = count > 0 ? sum / count : 0;
    });
    // Step 2: go back through and replace every null with that column's average
    let imputedCount = 0;
    data.forEach(row => {
        cols.forEach(col => {
            if (row[col] === null) { row[col] = means[col]; imputedCount++; }
        });
    });
    return { means, imputedCount }; // imputedCount = how many cells we had to guess-fill
}

// ------------------------------------------------------------------
// imputeConstant(): same idea as imputeMean, but instead of using the
// average, every missing cell gets replaced with the SAME fixed number
// (the `constant` argument). Used for phase-fraction columns, where a
// missing value really just means "this phase doesn't form" = 0, so
// filling in the average would be misleading.
// ------------------------------------------------------------------
function imputeConstant(data, cols, constant) {
    let imputedCount = 0;
    data.forEach(row => {
        cols.forEach(col => {
            let v = toNumericOrNull(row[col]);
            if (v === null) {
                row[col] = constant;
                imputedCount++;
            } else {
                row[col] = v; // normalize: number
            }
        });
    });
    return { constant, imputedCount };
}

// ============================================================
// 2. Standardization
// ============================================================
// Different columns can live on totally different scales (e.g. "Density"
// might range 2-3, while "Yield Strength" ranges 100-500). If we compared
// them directly, the big-number column would completely dominate. So we
// "standardize" every column: subtract its average, then divide by its
// spread (standard deviation). After this, every column has an average of
// 0 and a similar "typical size", so they're fair to compare/combine.
// ============================================================

function standardizeMatrix(data, cols) {
    let n = data.length, d = cols.length;
    let means = new Array(d).fill(0), stds = new Array(d).fill(0);

    // average of each column
    for (let j = 0; j < d; j++) {
        let sum = 0;
        for (let i = 0; i < n; i++) sum += data[i][cols[j]];
        means[j] = sum / n;
    }
    // spread (standard deviation) of each column
    for (let j = 0; j < d; j++) {
        let sq = 0;
        for (let i = 0; i < n; i++) sq += (data[i][cols[j]] - means[j]) ** 2;
        stds[j] = Math.sqrt(sq / (n - 1)) || 1; // guard against constant columns
    }

    // Build the standardized version of the data: same shape, but every
    // value is now "how many standard deviations away from average" it is
    let matrix = new Array(n);
    for (let i = 0; i < n; i++) {
        let row = new Array(d);
        for (let j = 0; j < d; j++) row[j] = (data[i][cols[j]] - means[j]) / stds[j];
        matrix[i] = row;
    }
    return { matrix, means, stds };
}

// ============================================================
// 3. PCA (Principal Component Analysis)
// ============================================================
// PCA is a technique for taking data with MANY columns (like 20+ alloy
// properties) and squashing it down to just 2 numbers per row (called
// "PC1" and "PC2") that we CAN plot on a normal x/y scatterplot - while
// still keeping as much of the "shape"/spread of the original data as
// possible. Chart 3 (the PCA map) is built entirely from this.
//
// The 3 functions below are the standard steps to compute PCA "by hand":
//   covarianceMatrix -> measures how much every pair of columns varies together
//   jacobiEigen      -> a numerical method that extracts the 2 "main directions"
//                       of variation out of that covariance matrix
//   computePCA2D     -> ties it all together into one easy-to-call function
// ============================================================

// Covariance measures how much two columns move TOGETHER (both go up
// together, one goes up while the other goes down, or no relationship).
// This builds the full grid of "column vs column" covariance values.
function covarianceMatrix(matrix) {
    let n = matrix.length, d = matrix[0].length;
    let cov = Array.from({ length: d }, () => new Array(d).fill(0));
    for (let a = 0; a < d; a++) {
        for (let b = a; b < d; b++) {
            let s = 0;
            for (let i = 0; i < n; i++) s += matrix[i][a] * matrix[i][b];
            cov[a][b] = cov[b][a] = s / (n - 1);
        }
    }
    return cov;
}

// Cyclic Jacobi eigenvalue algorithm for symmetric matrices.
// This is a classic numerical-math recipe that digs the "main directions
// of spread" (called eigenvectors) and how important each direction is
// (called eigenvalues) out of the covariance matrix above. You don't need
// to trace through the math line-by-line - just know that its OUTPUT is:
// "here are the directions the data spreads out the most, ranked from
// most-important to least-important".
function jacobiEigen(A, maxSweeps = 60, tol = 1e-9) {
    let d = A.length;
    let M = A.map(row => row.slice());
    let V = Array.from({ length: d }, (_, i) =>
        Array.from({ length: d }, (_, j) => (i === j ? 1 : 0))
    );

    // Repeatedly "rotate" pairs of columns to zero out their off-diagonal
    // relationship, until what's left is (close to) a purely diagonal
    // matrix - at which point the diagonal values ARE the eigenvalues.
    for (let sweep = 0; sweep < maxSweeps; sweep++) {
        let off = 0;
        for (let p = 0; p < d; p++)
            for (let q = p + 1; q < d; q++) off += M[p][q] * M[p][q];
        if (off < tol) break; // close enough to done, stop early

        for (let p = 0; p < d; p++) {
            for (let q = p + 1; q < d; q++) {
                if (Math.abs(M[p][q]) < 1e-12) continue;
                let theta = (M[q][q] - M[p][p]) / (2 * M[p][q]);
                let t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
                let c = 1 / Math.sqrt(t * t + 1), s = t * c;

                for (let k = 0; k < d; k++) {
                    let mkp = M[k][p], mkq = M[k][q];
                    M[k][p] = c * mkp - s * mkq;
                    M[k][q] = s * mkp + c * mkq;
                }
                for (let k = 0; k < d; k++) {
                    let mpk = M[p][k], mqk = M[q][k];
                    M[p][k] = c * mpk - s * mqk;
                    M[q][k] = s * mpk + c * mqk;
                }
                for (let k = 0; k < d; k++) {
                    let vkp = V[k][p], vkq = V[k][q];
                    V[k][p] = c * vkp - s * vkq;
                    V[k][q] = s * vkp + c * vkq;
                }
            }
        }
    }

    // Sort the results from "most important direction" to "least important"
    let eigenvalues = M.map((row, i) => row[i]);
    let eigenvectors = eigenvalues.map((_, i) => V.map(row => row[i]));
    let order = eigenvalues.map((_, i) => i).sort((a, b) => eigenvalues[b] - eigenvalues[a]);
    return {
        eigenvalues: order.map(i => eigenvalues[i]),
        eigenvectors: order.map(i => eigenvectors[i])
    };
}

// Full PCA pipeline. cols = numeric columns to include (already cleaned/imputed). Returns { points: [{pc1,pc2}], varianceExplained: [v1,v2] }
// This is the function the rest of the app actually calls - it wraps up
// standardizeMatrix + covarianceMatrix + jacobiEigen into one simple call:
// "give me the data and which columns to use, I'll give you back an (x,y)
// position for every row, plus how much of the original variety each axis
// captures."
function computePCA2D(data, cols) {
    let { matrix } = standardizeMatrix(data, cols);
    let cov = covarianceMatrix(matrix);
    let { eigenvalues, eigenvectors } = jacobiEigen(cov);
    let totalVar = eigenvalues.reduce((a, b) => a + b, 0);
    let pc1 = eigenvectors[0], pc2 = eigenvectors[1]; // the 2 most important directions

    // Project every row onto those 2 directions to get its (pc1, pc2) position
    let points = matrix.map(row => ({
        pc1: row.reduce((s, v, j) => s + v * pc1[j], 0),
        pc2: row.reduce((s, v, j) => s + v * pc2[j], 0)
    }));

    // "Loadings" = how much each original column contributes to PC1/PC2.
    // Sorted so the most influential columns come first - this powers the
    // little "top 5 drivers" bar list under the PCA chart.
    let loadings = {
        pc1: cols.map((col, j) => ({ col, loading: pc1[j] }))
            .sort((a, b) => Math.abs(b.loading) - Math.abs(a.loading)),
        pc2: cols.map((col, j) => ({ col, loading: pc2[j] }))
            .sort((a, b) => Math.abs(b.loading) - Math.abs(a.loading))
    };

    return {
        points,
        // what fraction (0 to 1) of the total spread in the data each axis explains
        varianceExplained: [eigenvalues[0] / totalVar, eigenvalues[1] / totalVar],
        loadings
    };
}

// ============================================================
// 4. Pareto front
// ============================================================
// A "Pareto-optimal" alloy is one where you can't find another alloy
// that's better on EVERY objective at once (e.g. higher strength AND
// lower cracking). These are the "best trade-off" alloys - not necessarily
// the single best at any one thing, but ones where improving one property
// would require giving up another. The "Pareto front" is the full set of
// such alloys. Chart 1 and Chart 2 highlight these in amber.
// ============================================================

// Fast version for exactly 2 objectives (e.g. Yield Strength vs. Cracking).
// keyA/keyB = which columns to compare, dirA/dirB = "max" (higher is
// better) or "min" (lower is better) for each one.
function paretoFront2D(data, keyA, dirA, keyB, dirB) {
    let signA = dirA === "max" ? 1 : -1;
    let signB = dirB === "max" ? 1 : -1;

    // Sort all rows from "best at A" to "worst at A"
    let idx = data.map((_, i) => i);
    idx.sort((i, j) => signA * data[j][keyA] - signA * data[i][keyA]);

    // Walk down that sorted list; a row only makes the front if it's ALSO
    // better at B than every row we've already accepted (bestB so far)
    let front = [];
    let bestB = -Infinity;
    idx.forEach(i => {
        let vb = signB * data[i][keyB];
        if (vb > bestB) {
            front.push(i);
            bestB = vb;
        }
    });
    return new Set(front); // a Set of row indexes that are on the front
}

// General Kung's algorithm for finding the non-dominated ("maximal") points of a set with up to 3 objectives.
// Same idea as paretoFront2D above, but works for ANY number of objectives
// (not just 2) using a smarter divide-and-conquer approach so it stays fast
// even with lots of rows.
function paretoFrontKung(data, objectives) {
    let d = objectives.length;
    let signs = objectives.map(o => o.dir === "max" ? 1 : -1);
    let coords = data.map(row => objectives.map((o, k) => signs[k] * row[o.key]));

    // "a dominates b" = a is at least as good as b on every objective, AND
    // strictly better on at least one - meaning there's no reason to prefer b.
    function dominates(a, b) {
        // a dominates b if a >= b in every dimension and a > b in at least one.
        let strictlyBetter = false;
        for (let k = 0; k < d; k++) {
            if (coords[a][k] < coords[b][k]) return false;
            if (coords[a][k] > coords[b][k]) strictlyBetter = true;
        }
        return strictlyBetter;
    }

    let idx = data.map((_, i) => i);

    // With only 1 objective, the "front" is simply whichever row(s) have the max value
    if (d === 1) {
        let maxVal = Math.max(...idx.map(i => coords[i][0]));
        return new Set(idx.filter(i => coords[i][0] === maxVal));
    }

    // Sort by the first objective descending; ties broken by the remaining objectives descending, so the two recursive halves are well-formed.
    idx.sort((a, b) => {
        for (let k = 0; k < d; k++) {
            if (coords[b][k] !== coords[a][k]) return coords[b][k] - coords[a][k];
        }
        return 0;
    });

    // Split the sorted list in half, find the front of each half separately,
    // then merge: a point from the right half only survives if nothing in
    // the left half already dominates it. This "divide and conquer" trick
    // is what makes it fast on large datasets.
    function front(list) {
        if (list.length <= 1) return list.slice();
        let mid = Math.floor(list.length / 2);
        let frontLeft = front(list.slice(0, mid));
        let frontRight = front(list.slice(mid));
        let survivors = frontRight.filter(r => !frontLeft.some(l => dominates(l, r)));
        return frontLeft.concat(survivors);
    }

    return new Set(front(idx));
}

// ============================================================
// 5. Correlation
// ============================================================
// "Correlation" is a single number between -1 and +1 that says how
// strongly two columns move together: +1 = perfectly together, -1 =
// perfectly opposite, 0 = no relationship at all. This powers Chart 4
// (the correlation heatmap).
// ============================================================

// Pearson correlation: the "classic" correlation, sensitive to actual
// numeric distances (assumes a roughly straight-line relationship).
function pearsonCorr(x, y) {
    let n = x.length;
    let mx = x.reduce((a, b) => a + b, 0) / n; // average of x
    let my = y.reduce((a, b) => a + b, 0) / n; // average of y
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < n; i++) {
        num += (x[i] - mx) * (y[i] - my);
        dx += (x[i] - mx) ** 2;
        dy += (y[i] - my) ** 2;
    }
    let denom = Math.sqrt(dx * dy);
    return denom === 0 ? 0 : num / denom;
}

// Turns a list of raw numbers into their "rank" (1st smallest, 2nd
// smallest, ...). Equal values share the average of the ranks they'd
// otherwise take up (this is the standard way to handle ties).
function rankArray(arr) {
    let idx = arr.map((_, i) => i).sort((a, b) => arr[a] - arr[b]);
    let ranks = new Array(arr.length);
    let i = 0;
    while (i < idx.length) {
        let j = i;
        while (j + 1 < idx.length && arr[idx[j + 1]] === arr[idx[i]]) j++;
        let avgRank = (i + j) / 2 + 1;
        for (let k = i; k <= j; k++) ranks[idx[k]] = avgRank;
        i = j + 1;
    }
    return ranks;
}

// Spearman correlation = Pearson correlation of ranks.  chart4-heatmap.js computes ranks once per column and reuses them across the whole N×N matrix instead of calling this per cell, since this function alone would re-rank both columns from scratch every time its called
// Spearman correlation is like Pearson, but it looks at RANK ORDER instead
// of raw numbers - so it still works even if the relationship is curved
// rather than a straight line, as long as it's consistently increasing or decreasing.
function spearmanCorr(x, y) {
    return pearsonCorr(rankArray(x), rankArray(y));
}

//Centered Log-Ratio (CLR) transformation
// A special transformation used for "composition" data (like percentages
// that must add up to 100%) - it makes those percentage columns behave
// better in things like PCA, by converting them to log-ratios relative to
// their own average instead of raw percentages.
function clrTransform(data, cols) {
    const ZERO_SUB = 0.001; // can't take log(0), so tiny/zero values get nudged up to this instead
    return data.map(row => {
        let vals = cols.map(c => {
            let v = +row[c];
            return (isFinite(v) && v > 0) ? v : ZERO_SUB;
        });
        let logGm = vals.reduce((s, v) => s + Math.log(v), 0) / vals.length; // log of the geometric mean
        let out = {};
        cols.forEach((c, i) => { out[c] = Math.log(vals[i]) - logGm; });
        return out;
    });
}

// ============================================================
// 6. Weighted score
// ============================================================
// Combines several columns into a SINGLE number per row, using
// user-chosen "weights" (how important each column should be). Used by
// the sliders in Chart 3 to color alloys by "how good" they are overall.
// ============================================================
function computeWeightedScore(data, weights) {
    let cols = Object.keys(weights);
    let wSum = cols.reduce((s, c) => s + weights[c], 0) || 1; // total of all weights, so we can normalize them to add up to 1
    let ranges = {};
    cols.forEach(c => {
        ranges[c] = [d3.min(data, d => d[c]), d3.max(data, d => d[c])];
    });
    data.forEach(d => {
        let score = 0;
        cols.forEach(c => {
            let [lo, hi] = ranges[c];
            // Rescale this column's value to a 0-1 range first, so columns
            // with big raw numbers don't unfairly dominate the score
            let norm = hi > lo ? (d[c] - lo) / (hi - lo) : 0;
            score += (weights[c] / wSum) * norm;
        });
        d.__score = score; // stash the result directly on the row for easy reuse
    });
}
