// Savings Allocation Tool
const STORAGE_KEY = 'savings_allocation_data_v2';

const IRS_LIMITS = {
    combined401k: 24500,
    hsaIndividual: 4400,
    hsaFamily: 8750,
    rothIRA: 7500
};

let data = getDefaultData();

function getDefaultData() {
    return {
        grossAnnualSalary: 0,
        taxInputMode: 'percentage',
        payFrequency: 24,
        // Percentage-based
        incomeTaxRate: 22,
        socialSecurityRate: 6.2,
        medicareRate: 1.45,
        otherPayrollTaxRate: 0,
        // Dollar-based (per paycheck)
        federalTaxPerPaycheck: 0,
        stateTaxPerPaycheck: 0,
        socialSecurityPerPaycheck: 0,
        medicarePerPaycheck: 0,
        otherPayrollPerPaycheck: 0,
        // Taxable income at the time withholding was entered; anchors the
        // derived income-tax rate so the entered dollars reproduce exactly
        // and then scale as pre-tax contributions change.
        taxBaselineIncome: 0,
        // FICA wages at lock-in, so entered SS/Medicare scale with HSA too.
        ficaBaselineWages: 0,
        healthInsurancePremium: 0,
        hsaCoverageType: 'individual',
        // 'every' = HSA out of every check; 'monthly' = out of one check a month.
        hsaSchedule: 'every',
        // Whether the entered withholding came from a check with HSA taken out.
        taxStubHasHSA: true,
        // Optional income tax from the *other* check (the opposite HSA case).
        // With both stubs, tax changes are scaled by the real top-bracket
        // rate between them instead of the lower average rate.
        otherStubFederal: 0,
        otherStubState: 0,
        otherStubBaselineIncome: 0,
        // Contribution setup saved at lock-in; the comparison panel treats it
        // as "Current" and the live sliders as "Proposed".
        currentSetup: null,
        employerMatch: 0,
        includeMatchInRate: true,
        allocations: {
            traditional401k: 0, roth401k: 0, hsa: 0,
            rothIRA: 0, emergencyFund: 0, taxableBrokerage: 0
        }
    };
}

// ====== PERSISTENCE ======
function loadData() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return;

    try {
        const parsed = JSON.parse(saved);
        data = { ...getDefaultData(), ...parsed, allocations: { ...getDefaultData().allocations, ...parsed.allocations } };

        // Migration from old effectiveTaxRate
        if (parsed.effectiveTaxRate !== undefined && parsed.incomeTaxRate === undefined) {
            data.incomeTaxRate = Math.max(0, parsed.effectiveTaxRate - 7.65);
            data.socialSecurityRate = 6.2;
            data.medicareRate = 1.45;
            delete data.effectiveTaxRate;
            saveData();
        }

        // Back-fill the income-tax baseline for data saved before it existed,
        // so previously entered withholding reproduces exactly on load instead
        // of falling back to the gross-minus-health approximation.
        if (data.taxInputMode === 'dollars' && !data.taxBaselineIncome
            && (data.federalTaxPerPaycheck > 0 || data.stateTaxPerPaycheck > 0)) {
            data.taxBaselineIncome = getStubBaseline().income;
            saveData();
        }
        if (data.taxInputMode === 'dollars' && data.taxBaselineIncome > 0 && !data.ficaBaselineWages
            && (data.socialSecurityPerPaycheck > 0 || data.medicarePerPaycheck > 0)) {
            data.ficaBaselineWages = getStubBaseline().fica;
            saveData();
        }
    } catch (e) {
        console.error('Failed to load saved data:', e);
        data = getDefaultData();
    }
}

function saveData() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

// ====== HELPERS ======
const $ = id => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);

function formatCurrency(value) {
    if (value == null || isNaN(value)) return '$0';
    const formatted = '$' + Math.abs(value).toLocaleString('en-US', { maximumFractionDigits: 0 });
    return value < 0 ? '-' + formatted : formatted;
}

function parseNum(value) {
    return parseFloat(String(value || 0).replace(/,/g, '')) || 0;
}

function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
}

function percentToDollars(pct) {
    return (pct / 100) * data.grossAnnualSalary;
}

function dollarsToPercent(dollars) {
    return data.grossAnnualSalary > 0 ? (dollars / data.grossAnnualSalary) * 100 : 0;
}

// How many checks a year have HSA taken out, and how many don't.
function getCheckCounts() {
    const freq = data.payFrequency;
    const withHSA = data.hsaSchedule === 'monthly' ? Math.min(12, freq) : freq;
    return { withHSA, withoutHSA: freq - withHSA };
}

// Wages for a single check, before taxes. HSA through payroll is exempt from
// both income tax and FICA; Traditional 401k is exempt from income tax only.
function getCheckWages(hasHSA) {
    const freq = data.payFrequency;
    const counts = getCheckCounts();
    const hsaPerCheck = hasHSA && counts.withHSA > 0
        ? percentToDollars(data.allocations.hsa) / counts.withHSA : 0;
    const gross = data.grossAnnualSalary / freq;
    const health = data.healthInsurancePremium * 12 / freq;
    const trad401k = percentToDollars(data.allocations.traditional401k) / freq;
    return {
        gross, health, trad401k, hsa: hsaPerCheck,
        taxable: Math.max(0, gross - health - trad401k - hsaPerCheck),
        ficaWages: Math.max(0, gross - health - hsaPerCheck)
    };
}

// Annualized wages of the check the withholding was copied from; this is
// what "Lock in" anchors to. With HSA on every check it equals annual
// taxable income, matching the original anchor.
function stubHasHSA() {
    return data.hsaSchedule !== 'monthly' || data.taxStubHasHSA;
}

function getStubBaseline() {
    const w = getCheckWages(stubHasHSA());
    const freq = data.payFrequency;
    const result = { income: w.taxable * freq, fica: w.ficaWages * freq, otherIncome: 0 };
    if (data.hsaSchedule === 'monthly') {
        result.otherIncome = getCheckWages(!stubHasHSA()).taxable * freq;
    }
    return result;
}

function hasOtherStub() {
    return data.hsaSchedule === 'monthly'
        && (data.otherStubFederal > 0 || data.otherStubState > 0);
}

// ====== LIMITS ======
function getHSALimit() {
    return data.hsaCoverageType === 'family' ? IRS_LIMITS.hsaFamily : IRS_LIMITS.hsaIndividual;
}

// Slider track length. 401k sliders share one limit, so both tracks stay on
// the full combined scale; moving one doesn't rescale (and visibly shift) the
// other. The input handler still clamps to the remaining headroom.
function getSliderMax(type) {
    const is401k = type === 'traditional401k' || type === 'roth401k';
    return is401k && data.grossAnnualSalary > 0
        ? Math.min(100, dollarsToPercent(IRS_LIMITS.combined401k))
        : getMaxPercent(type);
}

function getMaxPercent(type) {
    if (data.grossAnnualSalary <= 0) return 100;

    const limitsByType = {
        traditional401k: IRS_LIMITS.combined401k - percentToDollars(data.allocations.roth401k),
        roth401k: IRS_LIMITS.combined401k - percentToDollars(data.allocations.traditional401k),
        hsa: getHSALimit(),
        rothIRA: IRS_LIMITS.rothIRA
    };

    const limit = limitsByType[type];
    if (limit === undefined) return 100;

    const maxDollars = Math.max(0, limit);
    return Math.min(100, dollarsToPercent(maxDollars));
}

// ====== CALCULATIONS ======
function calculateBreakdown() {
    const gross = data.grossAnnualSalary;
    const alloc = data.allocations;

    // Convert allocations to dollars
    const dollars = Object.fromEntries(
        Object.entries(alloc).map(([k, v]) => [k, percentToDollars(v)])
    );

    const employerMatchDollars = percentToDollars(data.employerMatch);
    const healthInsAnnual = data.healthInsurancePremium * 12;
    const freq = data.payFrequency;

    // Pre-tax deductions
    const preTaxDeductions = {
        traditional401k: dollars.traditional401k,
        hsa: dollars.hsa,
        healthInsurance: healthInsAnnual
    };
    const totalPreTax = Object.values(preTaxDeductions).reduce((a, b) => a + b, 0);

    // Dollar mode: entered per-check amounts reproduce exactly on the stub
    // check at lock-in, then scale with that check's taxable / FICA wages.
    const enteredFederal = data.federalTaxPerPaycheck;
    const enteredIncomeTax = enteredFederal + data.stateTaxPerPaycheck;
    const federalRatio = enteredIncomeTax > 0 ? enteredFederal / enteredIncomeTax : 0;
    // Fall back to gross minus health if no baseline was captured yet.
    const incomeRef = (data.taxBaselineIncome > 0 ? data.taxBaselineIncome : gross - healthInsAnnual) / freq;
    const ficaRef = data.ficaBaselineWages / freq;
    // Two-stub mode: the top-bracket rate between the two real checks.
    const otherRef = data.otherStubBaselineIncome / freq;
    const twoStub = hasOtherStub() && data.taxBaselineIncome > 0 && otherRef > 0
        && Math.abs(otherRef - incomeRef) > 0.5;
    const marginal = twoStub ? {
        federal: (data.otherStubFederal - data.federalTaxPerPaycheck) / (otherRef - incomeRef),
        state: (data.otherStubState - data.stateTaxPerPaycheck) / (otherRef - incomeRef)
    } : null;

    // Taxes and take-home for one check, with or without HSA taken out.
    const calcCheck = hasHSA => {
        const w = getCheckWages(hasHSA);
        let t;
        if (data.taxInputMode === 'dollars') {
            const ficaScale = ficaRef > 0 ? w.ficaWages / ficaRef : 1;
            t = {
                ss: data.socialSecurityPerPaycheck * ficaScale,
                medicare: data.medicarePerPaycheck * ficaScale,
                // NY PFL / disability are based on gross, not reduced by HSA.
                other: data.otherPayrollPerPaycheck
            };
            if (twoStub) {
                const delta = w.taxable - incomeRef;
                t.federal = Math.max(0, data.federalTaxPerPaycheck + marginal.federal * delta);
                t.state = Math.max(0, data.stateTaxPerPaycheck + marginal.state * delta);
                t.income = t.federal + t.state;
            } else {
                if (incomeRef > 0 && enteredIncomeTax > 0) {
                    t.income = w.taxable * (enteredIncomeTax / incomeRef);
                } else {
                    t.income = enteredIncomeTax;
                }
                t.federal = t.income * federalRatio;
                t.state = t.income - t.federal;
            }
        } else {
            t = {
                federal: null,
                state: null,
                ss: w.ficaWages * (data.socialSecurityRate / 100),
                medicare: w.ficaWages * (data.medicareRate / 100),
                other: w.ficaWages * (data.otherPayrollTaxRate / 100),
                income: w.taxable * (data.incomeTaxRate / 100)
            };
        }
        t.payroll = t.ss + t.medicare + t.other;
        t.total = t.payroll + t.income;
        // The deposited check excludes only payroll-withheld items (Roth
        // 401k). Roth IRA is funded manually after the check arrives.
        const inCheck = w.taxable - t.total - dollars.roth401k / freq;
        return { ...w, taxes: t, inCheck, afterRothIRA: inCheck - dollars.rothIRA / freq };
    };

    const counts = getCheckCounts();
    const checks = { withHSA: calcCheck(true), withoutHSA: calcCheck(false), counts };
    const annual = fn => fn(checks.withHSA) * counts.withHSA + fn(checks.withoutHSA) * counts.withoutHSA;

    const taxableIncome = annual(c => c.taxable);
    const taxes = {};
    ['ss', 'medicare', 'other', 'payroll', 'income', 'total'].forEach(k => {
        taxes[k] = annual(c => c.taxes[k]);
    });
    const isDollar = data.taxInputMode === 'dollars';
    taxes.federal = isDollar ? annual(c => c.taxes.federal) : null;
    taxes.state = isDollar ? annual(c => c.taxes.state) : null;

    // Post-tax deductions
    const postTaxDeductions = {
        roth401k: dollars.roth401k,
        rothIRA: dollars.rothIRA,
        emergencyFund: dollars.emergencyFund,
        taxableBrokerage: dollars.taxableBrokerage
    };
    const totalPostTax = Object.values(postTaxDeductions).reduce((a, b) => a + b, 0);

    const afterTax = taxableIncome - taxes.total;
    const takeHome = afterTax - totalPostTax;
    const totalSavings = Object.values(dollars).reduce((a, b) => a + b, 0);

    const paycheckAnnual = afterTax - dollars.roth401k;
    const afterRothIRAAnnual = paycheckAnnual - dollars.rothIRA;

    const savingsRate = gross > 0
        ? ((totalSavings + (data.includeMatchInRate ? employerMatchDollars : 0)) / gross) * 100
        : 0;

    return {
        gross, taxableIncome, taxes, afterTax, takeHome, savingsRate,
        preTaxDeductions, postTaxDeductions, totalPreTax, totalPostTax,
        totalSavings, employerMatchDollars, paycheckAnnual, afterRothIRAAnnual, checks
    };
}

// Breakdown for a saved contribution setup. Salary, health insurance, tax
// inputs and employer match stay shared; only contributions are swapped.
function breakdownFor(setup) {
    const saved = { allocations: data.allocations, hsaSchedule: data.hsaSchedule };
    try {
        data.allocations = { ...data.allocations, ...setup.allocations };
        data.hsaSchedule = setup.hsaSchedule;
        return calculateBreakdown();
    } finally {
        data.allocations = saved.allocations;
        data.hsaSchedule = saved.hsaSchedule;
    }
}

// ====== UI UPDATES ======
function updateSliderFill(slider) {
    const range = slider.max - slider.min;
    const pct = range > 0 ? ((slider.value - slider.min) / range) * 100 : 0;
    slider.style.setProperty('--slider-percent', pct + '%');
}

function updateUI() {
    const b = calculateBreakdown();

    // Per-paycheck take-home (before and after manual Roth IRA contribution)
    const freq = data.payFrequency;
    $('paycheckTakeHome').textContent = formatCurrency(b.paycheckAnnual / freq);
    $('paycheckAfterRothIRA').textContent = formatCurrency(b.afterRothIRAAnnual / freq);
    $('paycheckTakeHome').classList.toggle('negative', b.paycheckAnnual < 0);
    $('paycheckAfterRothIRA').classList.toggle('negative', b.afterRothIRAAnnual < 0);
    $('paycheckFreqLabel').textContent = freq === 26 ? 'Biweekly · 26/yr' : 'Semi-monthly · 24/yr';

    // When HSA comes out of only one check a month, show both checks.
    const split = b.checks.counts.withoutHSA > 0;
    $('paycheckSingle').style.display = split ? 'none' : 'flex';
    $('paycheckSplit').style.display = split ? 'flex' : 'none';
    if (split) {
        [['WithHSA', b.checks.withHSA, b.checks.counts.withHSA, 'With HSA'],
         ['WithoutHSA', b.checks.withoutHSA, b.checks.counts.withoutHSA, 'Without HSA']]
            .forEach(([key, c, count, title]) => {
                $('paycheck' + key + 'Title').textContent = `${title} · ${count}/yr`;
                $('paycheck' + key).textContent = formatCurrency(c.inCheck);
                $('paycheck' + key + 'AfterRothIRA').textContent = formatCurrency(c.afterRothIRA);
                $('paycheck' + key).classList.toggle('negative', c.inCheck < 0);
                $('paycheck' + key + 'AfterRothIRA').classList.toggle('negative', c.afterRothIRA < 0);
            });
    }
    $('sumCheckLabel').textContent = split ? 'Avg / Check' : 'Per Check';
    $$('.stub-hsa-group').forEach(el => el.style.display = split ? 'block' : 'none');
    const otherLabel = stubHasHSA() ? 'without' : 'with';
    $$('.other-stub-kind').forEach(el => el.textContent = otherLabel);

    // Anchor status: compare the stub check's current taxable income to the
    // locked-in baseline
    const baseline = data.taxBaselineIncome;
    const anchorStatus = $('anchorStatus');
    if (anchorStatus) {
        if (!(baseline > 0)) {
            anchorStatus.textContent = 'Not anchored yet — lock in to match your real paycheck';
            anchorStatus.className = 'anchor-status unset';
        } else if (hasOtherStub() && !(data.otherStubBaselineIncome > 0)) {
            anchorStatus.textContent = 'Other check entered — lock in again to use both stubs.';
            anchorStatus.className = 'anchor-status unset';
        } else if (Math.abs(getStubBaseline().income - baseline) < 1) {
            const stubCheck = stubHasHSA() ? b.checks.withHSA : b.checks.withoutHSA;
            anchorStatus.textContent = `Anchored — matches your real paycheck (${formatCurrency(stubCheck.inCheck)}/check)`;
            anchorStatus.className = 'anchor-status anchored';
        } else {
            anchorStatus.textContent = 'Exploring — income tax estimated from your locked-in paycheck. Lock in again if these are now your real numbers.';
            anchorStatus.className = 'anchor-status exploring';
        }
    }
    $('currentRate').textContent = b.savingsRate.toFixed(1) + '%';
    $('savingsProgress').style.width = Math.min(b.savingsRate / 25 * 100, 100) + '%';
    $('matchValue').textContent = formatCurrency(b.employerMatchDollars) + '/yr';

    // Summary table: gross decomposes into taxes + health + savings + take-home,
    // shown per paycheck / month / year.
    const setSummaryRow = (key, annual) => {
        $('sum' + key + 'Check').textContent = formatCurrency(annual / freq);
        $('sum' + key + 'Month').textContent = formatCurrency(annual / 12);
        $('sum' + key + 'Year').textContent = formatCurrency(annual);
    };
    setSummaryRow('Gross', b.gross);
    setSummaryRow('Tax', b.taxes.total);
    setSummaryRow('Health', b.preTaxDeductions.healthInsurance);
    setSummaryRow('Savings', b.totalSavings);
    setSummaryRow('TakeHome', b.takeHome);

    // Status message
    let status;
    if (b.gross <= 0) {
        status = 'Enter your income to get started';
    } else if (b.savingsRate >= 25) {
        status = "You're meeting the 25% savings target!";
    } else {
        status = `Save ${(25 - b.savingsRate).toFixed(1)}% more to reach 25%`;
    }
    $('rateStatus').textContent = status;

    // Breakdown section
    const breakdown = {
        breakdownGrossAnnual: b.gross,
        breakdownGrossMonthly: b.gross / 12,
        breakdownPreTaxAnnual: -b.totalPreTax,
        breakdownPreTaxMonthly: -b.totalPreTax / 12,
        breakdown401k: b.preTaxDeductions.traditional401k,
        breakdownHSA: b.preTaxDeductions.hsa,
        breakdownHealthIns: b.preTaxDeductions.healthInsurance,
        breakdownTaxableAnnual: b.taxableIncome,
        breakdownTaxableMonthly: b.taxableIncome / 12,
        breakdownTaxesAnnual: -b.taxes.total,
        breakdownTaxesMonthly: -b.taxes.total / 12,
        breakdownPayrollTaxes: b.taxes.payroll,
        breakdownIncomeTax: b.taxes.income,
        breakdownAfterTaxAnnual: b.afterTax,
        breakdownAfterTaxMonthly: b.afterTax / 12,
        breakdownPostTaxAnnual: -b.totalPostTax,
        breakdownPostTaxMonthly: -b.totalPostTax / 12,
        breakdownRoth401k: b.postTaxDeductions.roth401k,
        breakdownRothIRA: b.postTaxDeductions.rothIRA,
        breakdownEmergency: b.postTaxDeductions.emergencyFund,
        breakdownBrokerage: b.postTaxDeductions.taxableBrokerage,
        breakdownTakeHomeAnnual: b.takeHome,
        breakdownTakeHomeMonthly: b.takeHome / 12
    };

    Object.entries(breakdown).forEach(([id, val]) => {
        const el = $(id);
        if (el) el.textContent = formatCurrency(val);
    });

    // Dollar mode tax breakdown
    if (b.taxes.federal !== null) {
        $('breakdownFederalTax').textContent = formatCurrency(b.taxes.federal);
        $('breakdownStateTax').textContent = formatCurrency(b.taxes.state);
    }

    // Visual bar
    if (b.gross > 0) {
        $('barPreTax').style.width = (b.totalPreTax / b.gross * 100) + '%';
        $('barTaxes').style.width = (b.taxes.total / b.gross * 100) + '%';
        $('barPostTax').style.width = (b.totalPostTax / b.gross * 100) + '%';
        $('barTakeHome').style.width = Math.max(0, b.takeHome / b.gross * 100) + '%';
    }

    // Monthly gross hint
    $('monthlyGrossHint').textContent = formatCurrency(data.grossAnnualSalary / 12) + '/month';

    // Allocations
    Object.keys(data.allocations).forEach(type => {
        const pct = data.allocations[type];
        const dollars = percentToDollars(pct);
        const slider = $(type + 'Slider');
        const input = $(type + 'Input');
        const dollarEl = $(type + 'Dollars');
        const limitEl = $(type + 'LimitStatus');

        if (slider && input) {
            // getMaxPercent returns the cap for this allocation, not the
            // remaining headroom, so pct must not be added back in.
            const maxPct = getMaxPercent(type);
            slider.max = getSliderMax(type);
            input.max = maxPct.toFixed(1);
            // Never rewrite the text box being typed in: reformatting on every
            // keystroke makes multi-digit and decimal entry impossible. The
            // slider is always synced so it stops at the clamped value.
            slider.value = pct;
            if (input !== document.activeElement) input.value = pct.toFixed(1);
            updateSliderFill(slider);
        }

        if (dollarEl) {
            dollarEl.textContent = `${formatCurrency(dollars)}/yr (${formatCurrency(dollars/12)}/mo)`;
        }

        if (limitEl) {
            let limit = null;
            if (type === 'hsa') {
                limit = getHSALimit();
            } else if (type === 'traditional401k' || type === 'roth401k') {
                limit = IRS_LIMITS.combined401k;
            } else if (type === 'rothIRA') {
                limit = IRS_LIMITS.rothIRA;
            }

            const atLimit = limit !== null && dollars >= limit - 1;
            limitEl.textContent = atLimit ? 'At IRS limit' : '';
            limitEl.classList.toggle('at-limit', atLimit);
        }
    });

    // 401k limit display
    const combined401k = percentToDollars(data.allocations.traditional401k + data.allocations.roth401k);
    const warning = $('combined401kWarning');
    if (combined401k >= IRS_LIMITS.combined401k) {
        warning.textContent = '401(k) limit reached ($24,500)';
        warning.className = 'limit-banner at-limit';
    } else {
        const pct = data.allocations.traditional401k + data.allocations.roth401k;
        warning.textContent = `401(k): ${formatCurrency(combined401k)} of $24,500 (${pct.toFixed(1)}% of salary)`;
        warning.className = 'limit-banner';
    }

    // Limit displays
    const salary = data.grossAnnualSalary;
    $('traditional401kLimit').textContent = salary > 0
        ? `Max: ${dollarsToPercent(IRS_LIMITS.combined401k).toFixed(1)}% ($24,500)` : 'Max: $24,500/yr';
    $('roth401kLimit').textContent = 'Shares $24,500 limit with Traditional';
    $('rothIRALimit').textContent = salary > 0
        ? `Max: ${dollarsToPercent(IRS_LIMITS.rothIRA).toFixed(1)}% ($7,500)` : 'Max: $7,500/yr';

    const hsaLimit = getHSALimit();
    $('hsaLimit').textContent = `Max: ${formatCurrency(hsaLimit)}/yr (${dollarsToPercent(hsaLimit).toFixed(1)}% of salary)`;

    updateComparison(b);
}

const ACCOUNT_LABELS = [
    ['Traditional 401k', 'traditional401k'], ['Roth 401k', 'roth401k'], ['HSA', 'hsa'],
    ['Roth IRA', 'rothIRA'], ['Emergency fund', 'emergencyFund'], ['Brokerage', 'taxableBrokerage']
];

// Compact sliders inside the comparison card. They drive the same
// allocations as the main sliders, so the two stay in sync.
function buildCompareSliders() {
    $('compareSliders').innerHTML = ACCOUNT_LABELS.map(([label, type]) => `
        <div class="compare-slider-row">
            <label for="cmp${type}Slider">${label}</label>
            <input type="range" class="allocation-slider" id="cmp${type}Slider" min="0" max="100" step="0.5" value="0">
            <span class="compare-slider-value" id="cmp${type}Value"></span>
        </div>`).join('');
}

function updateCompareSliders() {
    const setup = data.currentSetup;
    ACCOUNT_LABELS.forEach(([, type]) => {
        const slider = $('cmp' + type + 'Slider');
        const pct = data.allocations[type];
        slider.max = getSliderMax(type);
        slider.value = pct;
        updateSliderFill(slider);
        const was = setup ? setup.allocations[type] || 0 : pct;
        const changed = Math.abs(was - pct) >= 0.05;
        $('cmp' + type + 'Value').innerHTML = `${pct.toFixed(1)}% · ${formatCurrency(percentToDollars(pct))}/yr`
            + (changed ? ` <span class="was">was ${was.toFixed(1)}%</span>` : '');
    });
}

// Current (locked-in) vs. Proposed (live sliders) comparison panel.
function updateComparison(proposed) {
    const setup = data.currentSetup;
    updateCompareSliders();
    $('compareEmpty').style.display = setup ? 'none' : 'block';
    $('compareResetBtn').style.display = setup ? 'inline-block' : 'none';
    if (!setup) {
        $('compareRows').innerHTML = '';
        $('compareTakeaway').textContent = '';
        return;
    }
    const current = breakdownFor(setup);

    // [label, value fn, higherIsBetter, format, startsSection]
    const money = formatCurrency;
    const pct = v => v.toFixed(1) + '%';
    const rows = [];
    const split = proposed.checks.counts.withoutHSA > 0 || current.checks.counts.withoutHSA > 0;
    if (split) {
        rows.push(['Check w/ HSA', b => b.checks.withHSA.inCheck, true, money]);
        rows.push(['Check w/o HSA', b => b.checks.withoutHSA.inCheck, true, money]);
    } else {
        rows.push(['Per check', b => b.checks.withHSA.inCheck, true, money]);
    }
    rows.push(['After Roth IRA / check', b => b.afterRothIRAAnnual / data.payFrequency, true, money]);
    rows.push(['Take-home / month', b => b.takeHome / 12, true, money]);
    rows.push(['Take-home / year', b => b.takeHome, true, money]);
    rows.push(['Taxes / year', b => b.taxes.total, false, money, true]);

    let first = true;
    ACCOUNT_LABELS.forEach(([label, key]) => {
        const val = b => ({ ...b.preTaxDeductions, ...b.postTaxDeductions })[key] || 0;
        if (val(current) < 0.5 && val(proposed) < 0.5) return;
        rows.push([label, val, true, money, first]);
        first = false;
    });
    rows.push(['Total savings / year', b => b.totalSavings, true, money, true]);
    rows.push(['Employer match / year', b => b.employerMatchDollars, true, money]);
    rows.push(['Savings rate', b => b.savingsRate, true, pct]);

    $('compareRows').innerHTML = rows.map(([label, fn, higherIsBetter, fmt, section]) => {
        const cur = fn(current), prop = fn(proposed), diff = prop - cur;
        const isZero = Math.abs(diff) < (fmt === pct ? 0.05 : 0.5);
        const good = (diff > 0) === higherIsBetter;
        const cls = isZero ? 'zero' : good ? 'up' : 'down';
        const sign = diff > 0 ? '+' : '−';
        const delta = isZero ? '—' : sign + fmt(Math.abs(diff));
        return `<div class="summary-row${section ? ' section' : ''}">
            <span class="summary-label">${label}</span>
            <span class="num neg">${fmt(cur)}</span>
            <span class="num">${fmt(prop)}</span>
            <span class="num delta ${cls}">${delta}</span>
        </div>`;
    }).join('');

    // Takeaway: how much of the extra saving is paid for by lower taxes.
    const moreSaved = proposed.totalSavings - current.totalSavings;
    const lessTakeHome = current.takeHome - proposed.takeHome;
    const taxSaved = current.taxes.total - proposed.taxes.total;
    let takeaway;
    if (Math.abs(moreSaved) < 0.5 && Math.abs(lessTakeHome) < 0.5) {
        takeaway = 'No change — move the sliders to try a new setup.';
    } else if (moreSaved > 0) {
        takeaway = `Saving ${money(moreSaved)}/yr more costs ${money(lessTakeHome)}/yr in take-home`
            + (taxSaved >= 0.5 ? ` — lower taxes cover ${money(taxSaved)}.` : '.');
    } else {
        takeaway = `Saving ${money(-moreSaved)}/yr less adds ${money(-lessTakeHome)}/yr to take-home`
            + (taxSaved <= -0.5 ? ` — ${money(-taxSaved)} of it goes to higher taxes.` : '.');
    }
    $('compareTakeaway').textContent = takeaway;
}

function updateTaxModeUI() {
    const isDollar = data.taxInputMode === 'dollars';

    document.querySelector('.percentage-mode-inputs').style.display = isDollar ? 'none' : 'block';
    document.querySelector('.dollar-mode-inputs').style.display = isDollar ? 'block' : 'none';
    $$('.dollar-mode-only').forEach(el => el.style.display = isDollar ? 'block' : 'none');
    $$('.dollar-mode-detail').forEach(el => el.style.display = isDollar ? 'flex' : 'none');
    $$('.percentage-mode-detail').forEach(el => el.style.display = isDollar ? 'none' : 'flex');

    $$('.mode-toggle .toggle-btn[data-mode]').forEach(btn =>
        btn.classList.toggle('active', btn.dataset.mode === data.taxInputMode));
    $$('.freq-btn').forEach(btn =>
        btn.classList.toggle('active', parseInt(btn.dataset.freq) === data.payFrequency));
}

// ====== EVENT BINDING ======
function bindInput(id, setter) {
    const el = $(id);
    if (!el) return;

    el.addEventListener('input', e => {
        setter(e.target.value);
        saveData();
        updateUI();
    });
}

function setupEvents() {
    // Simple inputs
    bindInput('grossSalary', v => data.grossAnnualSalary = parseNum(v));
    bindInput('healthInsurance', v => data.healthInsurancePremium = parseNum(v));
    bindInput('employerMatch', v => data.employerMatch = clamp(parseNum(v), 0, 100));

    // Percentage tax inputs
    bindInput('incomeTaxRate', v => data.incomeTaxRate = clamp(parseNum(v), 0, 50));
    bindInput('socialSecurityRate', v => data.socialSecurityRate = clamp(parseNum(v), 0, 20));
    bindInput('medicareRate', v => data.medicareRate = clamp(parseNum(v), 0, 10));
    bindInput('otherPayrollTaxRate', v => data.otherPayrollTaxRate = clamp(parseNum(v), 0, 10));

    // Dollar tax inputs. The income-tax baseline is set explicitly via the
    // "Lock in as my real paycheck" button, not while typing, so anchoring is
    // deliberate and order-independent.
    bindInput('federalTaxPerPaycheck', v => data.federalTaxPerPaycheck = Math.max(0, parseNum(v)));
    bindInput('stateTaxPerPaycheck', v => data.stateTaxPerPaycheck = Math.max(0, parseNum(v)));
    bindInput('socialSecurityPerPaycheck', v => data.socialSecurityPerPaycheck = Math.max(0, parseNum(v)));
    bindInput('medicarePerPaycheck', v => data.medicarePerPaycheck = Math.max(0, parseNum(v)));
    bindInput('otherPayrollPerPaycheck', v => data.otherPayrollPerPaycheck = Math.max(0, parseNum(v)));
    bindInput('otherStubFederal', v => data.otherStubFederal = Math.max(0, parseNum(v)));
    bindInput('otherStubState', v => data.otherStubState = Math.max(0, parseNum(v)));

    // Toggles
    $$('.mode-toggle .toggle-btn[data-mode]').forEach(btn => {
        btn.addEventListener('click', e => {
            $$('.mode-toggle .toggle-btn[data-mode]').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            data.taxInputMode = e.target.dataset.mode;
            updateTaxModeUI();
            saveData();
            updateUI();
        });
    });

    $$('.freq-btn').forEach(btn => {
        btn.addEventListener('click', e => {
            $$('.freq-btn').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            data.payFrequency = parseInt(e.target.dataset.freq);
            saveData();
            updateUI();
        });
    });

    $$('.hsa-toggle .toggle-btn[data-type]').forEach(btn => {
        btn.addEventListener('click', e => {
            $$('.hsa-toggle .toggle-btn[data-type]').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            data.hsaCoverageType = e.target.dataset.type;
            saveData();
            updateUI();
        });
    });

    $$('.hsa-schedule-toggle .toggle-btn').forEach(btn => {
        btn.addEventListener('click', e => {
            $$('.hsa-schedule-toggle .toggle-btn').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            data.hsaSchedule = e.target.dataset.schedule;
            saveData();
            updateUI();
        });
    });

    $$('.stub-toggle .toggle-btn').forEach(btn => {
        btn.addEventListener('click', e => {
            $$('.stub-toggle .toggle-btn').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            data.taxStubHasHSA = e.target.dataset.stub === 'with';
            saveData();
            updateUI();
        });
    });

    // Allocations
    Object.keys(data.allocations).forEach(type => {
        const handler = v => {
            const pct = clamp(parseNum(v), 0, 100);
            data.allocations[type] = Math.min(pct, getMaxPercent(type));
            saveData();
            updateUI();
        };
        bindInput(type + 'Slider', handler);
        bindInput('cmp' + type + 'Slider', handler);
        bindInput(type + 'Input', handler);

        // Snap the box to the stored (clamped) value on blur, so a half-typed
        // or over-limit entry doesn't linger in the field.
        const input = $(type + 'Input');
        if (input) {
            input.addEventListener('blur', () => {
                input.value = data.allocations[type].toFixed(1);
            });
        }
    });

    // Anchor: lock in current setup as the real paycheck
    $('anchorBtn').addEventListener('click', () => {
        const stub = getStubBaseline();
        data.taxBaselineIncome = stub.income;
        data.ficaBaselineWages = stub.fica;
        data.otherStubBaselineIncome = stub.otherIncome;
        data.currentSetup = {
            allocations: { ...data.allocations },
            hsaSchedule: data.hsaSchedule,
            savedAt: Date.now()
        };
        saveData();
        updateUI();
    });

    // Comparison: put the sliders back to the locked-in setup
    $('compareResetBtn').addEventListener('click', () => {
        if (!data.currentSetup) return;
        data.allocations = { ...data.allocations, ...data.currentSetup.allocations };
        data.hsaSchedule = data.currentSetup.hsaSchedule;
        saveData();
        populateForm();
        updateUI();
    });

    // Include match toggle
    $('includeMatchToggle').addEventListener('change', e => {
        data.includeMatchInRate = e.target.checked;
        saveData();
        updateUI();
    });

    // Reset
    $('resetBtn').addEventListener('click', () => {
        if (confirm('Reset all data? This cannot be undone.')) {
            localStorage.removeItem(STORAGE_KEY);
            data = getDefaultData();
            populateForm();
            updateUI();
        }
    });
}

function populateForm() {
    // Simple fields
    $('grossSalary').value = data.grossAnnualSalary || '';
    $('healthInsurance').value = data.healthInsurancePremium || '';
    $('employerMatch').value = data.employerMatch || 0;
    $('includeMatchToggle').checked = data.includeMatchInRate;

    // Percentage inputs
    $('incomeTaxRate').value = data.incomeTaxRate;
    $('socialSecurityRate').value = data.socialSecurityRate;
    $('medicareRate').value = data.medicareRate;
    $('otherPayrollTaxRate').value = data.otherPayrollTaxRate;

    // Dollar inputs
    $('federalTaxPerPaycheck').value = data.federalTaxPerPaycheck || 0;
    $('stateTaxPerPaycheck').value = data.stateTaxPerPaycheck || 0;
    $('socialSecurityPerPaycheck').value = data.socialSecurityPerPaycheck || 0;
    $('medicarePerPaycheck').value = data.medicarePerPaycheck || 0;
    $('otherPayrollPerPaycheck').value = data.otherPayrollPerPaycheck || 0;
    $('otherStubFederal').value = data.otherStubFederal || '';
    $('otherStubState').value = data.otherStubState || '';

    // Toggles
    $$('.hsa-toggle .toggle-btn[data-type]').forEach(btn =>
        btn.classList.toggle('active', btn.dataset.type === data.hsaCoverageType));
    $$('.hsa-schedule-toggle .toggle-btn').forEach(btn =>
        btn.classList.toggle('active', btn.dataset.schedule === data.hsaSchedule));
    $$('.stub-toggle .toggle-btn').forEach(btn =>
        btn.classList.toggle('active', (btn.dataset.stub === 'with') === data.taxStubHasHSA));

    updateTaxModeUI();

    // Allocations
    Object.entries(data.allocations).forEach(([type, val]) => {
        const slider = $(type + 'Slider');
        const input = $(type + 'Input');
        if (slider) { slider.value = val; updateSliderFill(slider); }
        if (input) input.value = val.toFixed(1);
    });
}

// ====== INIT ======
document.addEventListener('DOMContentLoaded', () => {
    loadData();
    buildCompareSliders();
    populateForm();
    setupEvents();
    updateUI();
});
