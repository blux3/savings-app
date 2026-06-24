// Savings Allocation Tool
const STORAGE_KEY = 'savings_allocation_data_v2';

const IRS_LIMITS = {
    combined401k: 23000,
    hsaIndividual: 4400,
    hsaFamily: 8750,
    rothIRA: 7000
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
        healthInsurancePremium: 0,
        hsaCoverageType: 'individual',
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
            data.taxBaselineIncome = getTaxableIncome();
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

// Income subject to income tax: gross minus pre-tax deductions (Traditional
// 401k, HSA, health insurance).
function getTaxableIncome() {
    const preTax = percentToDollars(data.allocations.traditional401k)
        + percentToDollars(data.allocations.hsa)
        + data.healthInsurancePremium * 12;
    return Math.max(0, data.grossAnnualSalary - preTax);
}

// ====== LIMITS ======
function getHSALimit() {
    return data.hsaCoverageType === 'family' ? IRS_LIMITS.hsaFamily : IRS_LIMITS.hsaIndividual;
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

    // Pre-tax deductions
    const preTaxDeductions = {
        traditional401k: dollars.traditional401k,
        hsa: dollars.hsa,
        healthInsurance: healthInsAnnual
    };
    const totalPreTax = Object.values(preTaxDeductions).reduce((a, b) => a + b, 0);
    const taxableIncome = Math.max(0, gross - totalPreTax);

    // Calculate taxes based on mode
    let taxes;
    if (data.taxInputMode === 'dollars') {
        const freq = data.payFrequency;

        // FICA taxes are based on gross wages (not reduced by 401k contributions)
        taxes = {
            ss: data.socialSecurityPerPaycheck * freq,
            medicare: data.medicarePerPaycheck * freq,
            other: data.otherPayrollPerPaycheck * freq
        };
        taxes.payroll = taxes.ss + taxes.medicare + taxes.other;

        // Income taxes ARE reduced by pre-tax contributions (traditional 401k, HSA)
        // Derive effective rate from entered amounts, then apply to actual taxable income
        const enteredFederal = data.federalTaxPerPaycheck * freq;
        const enteredState = data.stateTaxPerPaycheck * freq;
        const enteredIncomeTax = enteredFederal + enteredState;

        // Anchor the effective rate to the taxable income captured when the
        // withholding was entered, so the entered dollars reproduce exactly at
        // that point and scale proportionally as pre-tax contributions change.
        // Fall back to gross minus health if no baseline was captured yet.
        const referenceIncome = data.taxBaselineIncome > 0
            ? data.taxBaselineIncome
            : gross - healthInsAnnual;

        if (referenceIncome > 0 && enteredIncomeTax > 0) {
            // Calculate effective rate and apply to actual taxable income
            const effectiveIncomeRate = enteredIncomeTax / referenceIncome;
            taxes.income = taxableIncome * effectiveIncomeRate;

            // Split proportionally between federal and state for display
            const federalRatio = enteredFederal / enteredIncomeTax;
            taxes.federal = taxes.income * federalRatio;
            taxes.state = taxes.income * (1 - federalRatio);
        } else {
            taxes.income = enteredIncomeTax;
            taxes.federal = enteredFederal;
            taxes.state = enteredState;
        }
    } else {
        const ficaWages = Math.max(0, gross - healthInsAnnual);
        taxes = {
            federal: null,
            state: null,
            ss: ficaWages * (data.socialSecurityRate / 100),
            medicare: ficaWages * (data.medicareRate / 100),
            other: ficaWages * (data.otherPayrollTaxRate / 100),
            income: taxableIncome * (data.incomeTaxRate / 100)
        };
        taxes.payroll = taxes.ss + taxes.medicare + taxes.other;
    }
    taxes.total = taxes.payroll + taxes.income;

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

    // Per-paycheck view: the deposited check excludes only payroll-withheld
    // items (Roth 401k). Roth IRA is funded manually after the check arrives.
    const paycheckAnnual = afterTax - dollars.roth401k;
    const afterRothIRAAnnual = paycheckAnnual - dollars.rothIRA;

    const savingsRate = gross > 0
        ? ((totalSavings + (data.includeMatchInRate ? employerMatchDollars : 0)) / gross) * 100
        : 0;

    return {
        gross, taxableIncome, taxes, afterTax, takeHome, savingsRate,
        preTaxDeductions, postTaxDeductions, totalPreTax, totalPostTax,
        totalSavings, employerMatchDollars, paycheckAnnual, afterRothIRAAnnual
    };
}

// ====== UI UPDATES ======
function updateSliderFill(slider) {
    const pct = ((slider.value - slider.min) / (slider.max - slider.min)) * 100;
    slider.style.setProperty('--slider-percent', pct + '%');
}

function updateUI() {
    const b = calculateBreakdown();

    // Dashboard
    $('monthlyTakeHome').textContent = formatCurrency(b.takeHome / 12);
    $('annualTakeHome').textContent = formatCurrency(b.takeHome);

    // Per-paycheck take-home (before and after manual Roth IRA contribution)
    const freq = data.payFrequency;
    $('paycheckTakeHome').textContent = formatCurrency(b.paycheckAnnual / freq);
    $('paycheckAfterRothIRA').textContent = formatCurrency(b.afterRothIRAAnnual / freq);
    $('paycheckTakeHome').classList.toggle('negative', b.paycheckAnnual < 0);
    $('paycheckAfterRothIRA').classList.toggle('negative', b.afterRothIRAAnnual < 0);
    $('paycheckFreqLabel').textContent = freq === 26 ? 'Biweekly · 26/yr' : 'Semi-monthly · 24/yr';
    $('currentRate').textContent = b.savingsRate.toFixed(1) + '%';
    $('savingsProgress').style.width = Math.min(b.savingsRate / 25 * 100, 100) + '%';
    $('monthlyTakeHome').classList.toggle('negative', b.takeHome < 0);
    $('matchValue').textContent = formatCurrency(b.employerMatchDollars) + '/yr';

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
            slider.max = Math.min(100, getMaxPercent(type) + pct);
            slider.value = pct;
            input.value = pct.toFixed(1);
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
        warning.textContent = '401(k) limit reached ($23,000)';
        warning.className = 'limit-banner at-limit';
    } else {
        const pct = data.allocations.traditional401k + data.allocations.roth401k;
        warning.textContent = `401(k): ${formatCurrency(combined401k)} of $23,000 (${pct.toFixed(1)}% of salary)`;
        warning.className = 'limit-banner';
    }

    // Limit displays
    const salary = data.grossAnnualSalary;
    $('traditional401kLimit').textContent = salary > 0
        ? `Max: ${dollarsToPercent(IRS_LIMITS.combined401k).toFixed(1)}% ($23,000)` : 'Max: $23,000/yr';
    $('roth401kLimit').textContent = 'Shares $23k limit with Traditional';
    $('rothIRALimit').textContent = salary > 0
        ? `Max: ${dollarsToPercent(IRS_LIMITS.rothIRA).toFixed(1)}% ($7,000)` : 'Max: $7,000/yr';

    const hsaLimit = getHSALimit();
    $('hsaLimit').textContent = `Max: ${formatCurrency(hsaLimit)}/yr (${dollarsToPercent(hsaLimit).toFixed(1)}% of salary)`;
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

    // Dollar tax inputs — capture the taxable-income baseline as the user
    // enters withholding, so the derived income-tax rate is anchored to their
    // current contribution levels.
    bindInput('federalTaxPerPaycheck', v => {
        data.federalTaxPerPaycheck = Math.max(0, parseNum(v));
        data.taxBaselineIncome = getTaxableIncome();
    });
    bindInput('stateTaxPerPaycheck', v => {
        data.stateTaxPerPaycheck = Math.max(0, parseNum(v));
        data.taxBaselineIncome = getTaxableIncome();
    });
    bindInput('socialSecurityPerPaycheck', v => data.socialSecurityPerPaycheck = Math.max(0, parseNum(v)));
    bindInput('medicarePerPaycheck', v => data.medicarePerPaycheck = Math.max(0, parseNum(v)));
    bindInput('otherPayrollPerPaycheck', v => data.otherPayrollPerPaycheck = Math.max(0, parseNum(v)));

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

    $$('.hsa-toggle .toggle-btn').forEach(btn => {
        btn.addEventListener('click', e => {
            $$('.hsa-toggle .toggle-btn').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            data.hsaCoverageType = e.target.dataset.type;
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
        bindInput(type + 'Input', handler);
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

    // Toggles
    $$('.hsa-toggle .toggle-btn').forEach(btn =>
        btn.classList.toggle('active', btn.dataset.type === data.hsaCoverageType));

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
    populateForm();
    setupEvents();
    updateUI();
});
