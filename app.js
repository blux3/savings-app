// Savings Allocation Tool
const STORAGE_KEY = 'savings_allocation_data_v2';

// IRS Limits for 2024 (dollar amounts)
const IRS_LIMITS = {
    combined401k: 23000,
    hsaIndividual: 4150,
    hsaFamily: 8300,
    rothIRA: 7000
};

// State
let data = getDefaultData();

// Default data structure - all allocations as percentages of gross
function getDefaultData() {
    return {
        grossAnnualSalary: 0,
        effectiveTaxRate: 22,
        healthInsurancePremium: 0,
        hsaCoverageType: 'individual',
        allocations: {
            traditional401k: 0,    // % of gross
            roth401k: 0,           // % of gross
            hsa: 0,                // % of gross
            rothIRA: 0,            // % of gross
            emergencyFund: 0,      // % of gross
            taxableBrokerage: 0    // % of gross
        }
    };
}

// ====== PERSISTENCE ======
function loadData() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
        try {
            const parsed = JSON.parse(saved);
            data = { ...getDefaultData(), ...parsed, allocations: { ...getDefaultData().allocations, ...parsed.allocations } };
        } catch (e) {
            console.error('Failed to load saved data:', e);
            data = getDefaultData();
        }
    }
}

function saveData() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

// ====== FORMATTING ======
function formatCurrency(value) {
    if (value === null || value === undefined || isNaN(value)) return '$0';
    const absValue = Math.abs(value);
    const formatted = '$' + absValue.toLocaleString('en-US', { maximumFractionDigits: 0 });
    return value < 0 ? '-' + formatted : formatted;
}

function formatPercent(value) {
    return value.toFixed(1) + '%';
}

function parseNumber(value) {
    if (!value && value !== 0) return 0;
    return parseFloat(String(value).replace(/,/g, '')) || 0;
}

// ====== CONVERSIONS ======
function percentToDollars(percent) {
    return (percent / 100) * data.grossAnnualSalary;
}

function dollarsToPercent(dollars) {
    if (data.grossAnnualSalary <= 0) return 0;
    return (dollars / data.grossAnnualSalary) * 100;
}

// ====== LIMITS ======
function getHSALimit() {
    return data.hsaCoverageType === 'family' ? IRS_LIMITS.hsaFamily : IRS_LIMITS.hsaIndividual;
}

function getMaxPercent(type) {
    if (data.grossAnnualSalary <= 0) return 100;

    switch (type) {
        case 'traditional401k': {
            const roth401kDollars = percentToDollars(data.allocations.roth401k);
            const remaining = IRS_LIMITS.combined401k - roth401kDollars;
            return Math.min(100, dollarsToPercent(Math.max(0, remaining)));
        }
        case 'roth401k': {
            const trad401kDollars = percentToDollars(data.allocations.traditional401k);
            const remaining = IRS_LIMITS.combined401k - trad401kDollars;
            return Math.min(100, dollarsToPercent(Math.max(0, remaining)));
        }
        case 'hsa':
            return Math.min(100, dollarsToPercent(getHSALimit()));
        case 'rothIRA':
            return Math.min(100, dollarsToPercent(IRS_LIMITS.rothIRA));
        default:
            return 100;
    }
}

function enforceLimit(type, percent) {
    percent = Math.max(0, Math.min(100, percent));
    const maxPercent = getMaxPercent(type);
    return Math.min(percent, maxPercent);
}

function getCombined401kPercent() {
    return data.allocations.traditional401k + data.allocations.roth401k;
}

function getCombined401kDollars() {
    return percentToDollars(getCombined401kPercent());
}

// ====== CALCULATIONS ======
function calculateBreakdown() {
    const grossAnnual = data.grossAnnualSalary;
    const grossMonthly = grossAnnual / 12;

    // Convert percentages to dollars
    const traditional401kDollars = percentToDollars(data.allocations.traditional401k);
    const roth401kDollars = percentToDollars(data.allocations.roth401k);
    const hsaDollars = percentToDollars(data.allocations.hsa);
    const rothIRADollars = percentToDollars(data.allocations.rothIRA);
    const emergencyFundDollars = percentToDollars(data.allocations.emergencyFund);
    const taxableBrokerageDollars = percentToDollars(data.allocations.taxableBrokerage);

    // Pre-tax deductions (annual)
    const preTaxDeductions = {
        traditional401k: traditional401kDollars,
        hsa: hsaDollars,
        healthInsurance: data.healthInsurancePremium * 12
    };
    const totalPreTaxAnnual = Object.values(preTaxDeductions).reduce((a, b) => a + b, 0);

    // Taxable income
    const taxableIncome = Math.max(0, grossAnnual - totalPreTaxAnnual);

    // Estimated taxes
    const estimatedTaxes = taxableIncome * (data.effectiveTaxRate / 100);

    // After-tax income
    const afterTaxIncome = taxableIncome - estimatedTaxes;

    // Post-tax deductions (annual)
    const postTaxDeductions = {
        roth401k: roth401kDollars,
        rothIRA: rothIRADollars,
        emergencyFund: emergencyFundDollars,
        taxableBrokerage: taxableBrokerageDollars
    };
    const totalPostTaxAnnual = Object.values(postTaxDeductions).reduce((a, b) => a + b, 0);

    // Take-home pay
    const takeHomeAnnual = afterTaxIncome - totalPostTaxAnnual;
    const takeHomeMonthly = takeHomeAnnual / 12;

    // Total savings
    const totalSavingsAnnual = traditional401kDollars + roth401kDollars + hsaDollars +
                               rothIRADollars + emergencyFundDollars + taxableBrokerageDollars;

    const savingsRate = grossAnnual > 0 ? (totalSavingsAnnual / grossAnnual) * 100 : 0;

    return {
        grossAnnual,
        grossMonthly,
        preTaxDeductions,
        totalPreTaxAnnual,
        taxableIncome,
        estimatedTaxes,
        afterTaxIncome,
        postTaxDeductions,
        totalPostTaxAnnual,
        takeHomeAnnual,
        takeHomeMonthly,
        totalSavingsAnnual,
        savingsRate
    };
}

// ====== UI UPDATES ======
function updateSliderFill(slider) {
    const min = parseFloat(slider.min) || 0;
    const max = parseFloat(slider.max) || 100;
    const value = parseFloat(slider.value) || 0;
    const percent = ((value - min) / (max - min)) * 100;
    slider.style.setProperty('--slider-percent', percent + '%');
}

function updateDashboard(breakdown) {
    document.getElementById('monthlyTakeHome').textContent = formatCurrency(breakdown.takeHomeMonthly);
    document.getElementById('annualTakeHome').textContent = formatCurrency(breakdown.takeHomeAnnual);
    document.getElementById('currentRate').textContent = breakdown.savingsRate.toFixed(1) + '%';

    // Progress bar (relative to 25% target)
    const progressPercent = Math.min((breakdown.savingsRate / 25) * 100, 100);
    document.getElementById('savingsProgress').style.width = progressPercent + '%';

    // Status message
    const statusEl = document.getElementById('rateStatus');
    if (breakdown.grossAnnual <= 0) {
        statusEl.textContent = 'Enter your income to get started';
    } else if (breakdown.savingsRate >= 25) {
        statusEl.textContent = 'You\'re meeting the 25% savings target!';
    } else {
        const needed = 25 - breakdown.savingsRate;
        statusEl.textContent = `Save ${needed.toFixed(1)}% more to reach 25%`;
    }

    // Warning for negative take-home
    const takeHomeEl = document.getElementById('monthlyTakeHome');
    if (breakdown.takeHomeMonthly < 0) {
        takeHomeEl.classList.add('negative');
    } else {
        takeHomeEl.classList.remove('negative');
    }
}

function updateBreakdown(breakdown) {
    // Gross
    document.getElementById('breakdownGrossAnnual').textContent = formatCurrency(breakdown.grossAnnual);
    document.getElementById('breakdownGrossMonthly').textContent = formatCurrency(breakdown.grossMonthly);

    // Pre-tax totals
    document.getElementById('breakdownPreTaxAnnual').textContent = '-' + formatCurrency(breakdown.totalPreTaxAnnual);
    document.getElementById('breakdownPreTaxMonthly').textContent = '-' + formatCurrency(breakdown.totalPreTaxAnnual / 12);

    // Pre-tax sub-items
    document.getElementById('breakdown401k').textContent = formatCurrency(breakdown.preTaxDeductions.traditional401k);
    document.getElementById('breakdownHSA').textContent = formatCurrency(breakdown.preTaxDeductions.hsa);
    document.getElementById('breakdownHealthIns').textContent = formatCurrency(breakdown.preTaxDeductions.healthInsurance);

    // Taxable income
    document.getElementById('breakdownTaxableAnnual').textContent = formatCurrency(breakdown.taxableIncome);
    document.getElementById('breakdownTaxableMonthly').textContent = formatCurrency(breakdown.taxableIncome / 12);

    // Taxes
    document.getElementById('breakdownTaxesAnnual').textContent = '-' + formatCurrency(breakdown.estimatedTaxes);
    document.getElementById('breakdownTaxesMonthly').textContent = '-' + formatCurrency(breakdown.estimatedTaxes / 12);

    // After-tax
    document.getElementById('breakdownAfterTaxAnnual').textContent = formatCurrency(breakdown.afterTaxIncome);
    document.getElementById('breakdownAfterTaxMonthly').textContent = formatCurrency(breakdown.afterTaxIncome / 12);

    // Post-tax totals
    document.getElementById('breakdownPostTaxAnnual').textContent = '-' + formatCurrency(breakdown.totalPostTaxAnnual);
    document.getElementById('breakdownPostTaxMonthly').textContent = '-' + formatCurrency(breakdown.totalPostTaxAnnual / 12);

    // Post-tax sub-items
    document.getElementById('breakdownRoth401k').textContent = formatCurrency(breakdown.postTaxDeductions.roth401k);
    document.getElementById('breakdownRothIRA').textContent = formatCurrency(breakdown.postTaxDeductions.rothIRA);
    document.getElementById('breakdownEmergency').textContent = formatCurrency(breakdown.postTaxDeductions.emergencyFund);
    document.getElementById('breakdownBrokerage').textContent = formatCurrency(breakdown.postTaxDeductions.taxableBrokerage);

    // Take-home
    document.getElementById('breakdownTakeHomeAnnual').textContent = formatCurrency(breakdown.takeHomeAnnual);
    document.getElementById('breakdownTakeHomeMonthly').textContent = formatCurrency(breakdown.takeHomeMonthly);

    // Update visual bar
    updateBreakdownBar(breakdown);
}

function updateBreakdownBar(breakdown) {
    const total = breakdown.grossAnnual;
    if (total <= 0) {
        document.getElementById('barPreTax').style.width = '0%';
        document.getElementById('barTaxes').style.width = '0%';
        document.getElementById('barPostTax').style.width = '0%';
        document.getElementById('barTakeHome').style.width = '0%';
        return;
    }

    const preTaxPercent = (breakdown.totalPreTaxAnnual / total) * 100;
    const taxesPercent = (breakdown.estimatedTaxes / total) * 100;
    const postTaxPercent = (breakdown.totalPostTaxAnnual / total) * 100;
    const takeHomePercent = Math.max(0, (breakdown.takeHomeAnnual / total) * 100);

    document.getElementById('barPreTax').style.width = preTaxPercent + '%';
    document.getElementById('barTaxes').style.width = taxesPercent + '%';
    document.getElementById('barPostTax').style.width = postTaxPercent + '%';
    document.getElementById('barTakeHome').style.width = takeHomePercent + '%';
}

function updateAllocationUI(type) {
    const slider = document.getElementById(type + 'Slider');
    const input = document.getElementById(type + 'Input');
    const percent = data.allocations[type];
    const dollars = percentToDollars(percent);

    if (slider && input) {
        // Update max based on limits
        const maxPercent = getMaxPercent(type);
        slider.max = Math.min(100, maxPercent + percent); // Allow current value even if at limit

        slider.value = percent;
        input.value = percent.toFixed(1);
        updateSliderFill(slider);
    }

    // Update dollar equivalent display
    const dollarEl = document.getElementById(type + 'Dollars');
    if (dollarEl) {
        const monthly = dollars / 12;
        dollarEl.textContent = `${formatCurrency(dollars)}/yr (${formatCurrency(monthly)}/mo)`;
    }

    // Show limit warning if at cap
    const limitEl = document.getElementById(type + 'LimitStatus');
    if (limitEl) {
        const limit = type === 'hsa' ? getHSALimit() :
                     (type === 'traditional401k' || type === 'roth401k') ? IRS_LIMITS.combined401k :
                     type === 'rothIRA' ? IRS_LIMITS.rothIRA : null;

        if (limit && dollars >= limit - 1) {
            limitEl.textContent = 'At IRS limit';
            limitEl.classList.add('at-limit');
        } else {
            limitEl.textContent = '';
            limitEl.classList.remove('at-limit');
        }
    }
}

function update401kLimitDisplay() {
    const combined = getCombined401kDollars();
    const remaining = IRS_LIMITS.combined401k - combined;
    const warningEl = document.getElementById('combined401kWarning');

    if (remaining <= 0) {
        warningEl.textContent = '401(k) limit reached ($23,000)';
        warningEl.className = 'limit-banner at-limit';
    } else {
        const combinedPercent = getCombined401kPercent();
        warningEl.textContent = `401(k): ${formatCurrency(combined)} of $23,000 (${combinedPercent.toFixed(1)}% of salary)`;
        warningEl.className = 'limit-banner';
    }
}

function updateHSALimit() {
    const limit = getHSALimit();
    const limitPercent = dollarsToPercent(limit);
    document.getElementById('hsaLimit').textContent = `Max: ${formatCurrency(limit)}/yr (${limitPercent.toFixed(1)}% of salary)`;

    const slider = document.getElementById('hsaSlider');
    if (slider) {
        // Enforce new limit
        const maxPercent = getMaxPercent('hsa');
        if (data.allocations.hsa > maxPercent) {
            data.allocations.hsa = maxPercent;
            saveData();
        }
        updateAllocationUI('hsa');
    }
}

function updateAllLimitDisplays() {
    // Update limit displays based on current salary
    const salary = data.grossAnnualSalary;

    // Traditional 401k
    const trad401kLimit = Math.min(100, dollarsToPercent(IRS_LIMITS.combined401k));
    document.getElementById('traditional401kLimit').textContent =
        salary > 0 ? `Max: ${trad401kLimit.toFixed(1)}% ($23,000)` : 'Max: $23,000/yr';

    // Roth 401k
    document.getElementById('roth401kLimit').textContent = 'Shares $23k limit with Traditional';

    // HSA
    updateHSALimit();

    // Roth IRA
    const rothIRALimit = Math.min(100, dollarsToPercent(IRS_LIMITS.rothIRA));
    document.getElementById('rothIRALimit').textContent =
        salary > 0 ? `Max: ${rothIRALimit.toFixed(1)}% ($7,000)` : 'Max: $7,000/yr';
}

function updateAllUI() {
    const breakdown = calculateBreakdown();
    updateDashboard(breakdown);
    updateBreakdown(breakdown);

    // Update monthly gross hint
    const hintEl = document.getElementById('monthlyGrossHint');
    if (hintEl) {
        hintEl.textContent = formatCurrency(data.grossAnnualSalary / 12) + '/month';
    }

    // Update all allocation displays
    Object.keys(data.allocations).forEach(type => {
        updateAllocationUI(type);
    });

    update401kLimitDisplay();
    updateAllLimitDisplays();
}

// ====== EVENT HANDLERS ======
function handleAllocationChange(type, percentValue) {
    const enforced = enforceLimit(type, parseNumber(percentValue));
    data.allocations[type] = enforced;
    saveData();
    updateAllUI();
}

function setupEventListeners() {
    // Gross salary
    document.getElementById('grossSalary').addEventListener('input', (e) => {
        data.grossAnnualSalary = parseNumber(e.target.value);
        saveData();
        updateAllUI();
    });

    // Tax rate
    document.getElementById('effectiveTaxRate').addEventListener('input', (e) => {
        data.effectiveTaxRate = Math.min(50, Math.max(0, parseNumber(e.target.value)));
        saveData();
        updateAllUI();
    });

    // Health insurance
    document.getElementById('healthInsurance').addEventListener('input', (e) => {
        data.healthInsurancePremium = parseNumber(e.target.value);
        saveData();
        updateAllUI();
    });

    // HSA toggle
    document.querySelectorAll('.hsa-toggle .toggle-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.hsa-toggle .toggle-btn').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            data.hsaCoverageType = e.target.dataset.type;
            updateHSALimit();
            saveData();
            updateAllUI();
        });
    });

    // Allocation sliders and inputs
    const allocationTypes = ['traditional401k', 'roth401k', 'hsa', 'rothIRA', 'emergencyFund', 'taxableBrokerage'];

    allocationTypes.forEach(type => {
        const slider = document.getElementById(type + 'Slider');
        const input = document.getElementById(type + 'Input');

        if (slider) {
            slider.addEventListener('input', (e) => {
                handleAllocationChange(type, e.target.value);
            });
        }

        if (input) {
            input.addEventListener('input', (e) => {
                handleAllocationChange(type, e.target.value);
            });
        }
    });

    // Reset button
    document.getElementById('resetBtn').addEventListener('click', () => {
        if (confirm('Reset all data? This cannot be undone.')) {
            localStorage.removeItem(STORAGE_KEY);
            data = getDefaultData();
            populateForm();
            updateAllUI();
        }
    });
}

function populateForm() {
    document.getElementById('grossSalary').value = data.grossAnnualSalary || '';
    document.getElementById('effectiveTaxRate').value = data.effectiveTaxRate;
    document.getElementById('healthInsurance').value = data.healthInsurancePremium || '';

    // HSA toggle
    document.querySelectorAll('.hsa-toggle .toggle-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.type === data.hsaCoverageType);
    });

    // Allocations
    Object.keys(data.allocations).forEach(type => {
        const slider = document.getElementById(type + 'Slider');
        const input = document.getElementById(type + 'Input');
        const value = data.allocations[type];

        if (slider) {
            slider.value = value;
            updateSliderFill(slider);
        }
        if (input) {
            input.value = value.toFixed(1);
        }
    });
}

// ====== INIT ======
function init() {
    loadData();
    populateForm();
    setupEventListeners();
    updateAllUI();
}

document.addEventListener('DOMContentLoaded', init);
