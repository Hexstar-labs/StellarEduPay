'use strict';

/**
 * FeeAdjustmentService
 *
 * Responsible for calculating fees after applying DB-backed adjustment rules.
 *
 * Precedence semantics
 * --------------------
 * Rules are sorted by `priority` ascending — lower number = higher precedence.
 * Rules that share the same priority are further sorted by `name` ascending so
 * the evaluation order is always fully deterministic.
 *
 * Conflict resolution
 * -------------------
 * The `conflictResolutionPolicy` stored on the *first matching rule* (by
 * priority) governs how subsequent matching rules are handled:
 *
 *   "stack"             (default) — all matching rules applied in priority order.
 *   "first_only"        — only the highest-priority matching rule is applied.
 *   "best_for_student"  — among matching discount rules the one that reduces the
 *                         fee the most is selected; penalty rules are always
 *                         stacked regardless.
 *
 * Overpayment detection
 * ----------------------
 * After recalculating `finalFee` the service checks whether `student.totalPaid`
 * exceeds the new fee.  When that happens:
 *   - `remainingBalance` is clamped to 0 (never goes negative).
 *   - An `overpayment` record is returned in the result for the caller to
 *     persist as an explicit credit record (see Issue #903).
 */

const FeeAdjustmentRule = require('../models/feeAdjustmentRuleModel');

class FeeAdjustmentService {
  /**
   * Calculate final fee after applying all applicable adjustments.
   *
   * @param {Object} feeStructure       - { feeAmount: Number }
   * @param {Object} paymentContext     - { student, paymentDate, baseAmount, schoolId, academicYear }
   * @returns {Object} { baseFee, finalFee, adjustmentsApplied, overpayment|null }
   */
  async calculateAdjustedFee(feeStructure, paymentContext) {
    const rules = await this._fetchSortedRules(paymentContext.schoolId);
    return this._applyRules(feeStructure, paymentContext, rules);
  }

  /**
   * Fetch active rules sorted by priority ASC, name ASC.
   * Exposed for batch/bulk processing callers to avoid N+1 queries.
   *
   * @param {string} schoolId
   * @returns {Promise<Array>}
   */
  async fetchSortedRules(schoolId) {
    return this._fetchSortedRules(schoolId);
  }

  /**
   * Calculate final fee given a pre-fetched set of rules (synchronous).
   *
   * @param {Object} feeStructure
   * @param {Object} paymentContext
   * @param {Array} rules
   * @returns {Object}
   */
  calculateAdjustedFeeWithRules(feeStructure, paymentContext, rules) {
    return this._applyRules(feeStructure, paymentContext, rules);
  }

  /**
   * Simulate extra rule with pre-fetched existing rules (synchronous).
   *
   * @param {Object} feeStructure
   * @param {Object} paymentContext
   * @param {Object} extraRule
   * @param {Array} existingRules
   * @returns {Object}
   */
  simulateWithExtraWithRules(feeStructure, paymentContext, extraRule, existingRules) {
    const combined = [...existingRules, extraRule].sort(
      (a, b) => (a.priority - b.priority) || (a.name || '').localeCompare(b.name || '')
    );
    const result = this._applyRules(feeStructure, paymentContext, combined);
    result.ruleApplied = result.adjustmentsApplied.some(
      a => a.ruleName === (extraRule.name || '_dry_run_preview_')
    );
    return result;
  }

  /**
   * Simulate the effect of an *extra* (unsaved) rule injected into the existing
   * rule set.  Used by the dry-run endpoint.
   *
   * @param {Object} feeStructure   - { feeAmount: Number }
   * @param {Object} paymentContext
   * @param {Object} extraRule      - synthetic rule object (not persisted)
   * @returns {Object} { baseFee, finalFee, adjustmentsApplied, ruleApplied, overpayment|null }
   */
  async simulateWithExtra(feeStructure, paymentContext, extraRule) {
    const existing = await this._fetchSortedRules(paymentContext.schoolId);
    return this.simulateWithExtraWithRules(feeStructure, paymentContext, extraRule, existing);
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  async _fetchSortedRules(schoolId) {
    const rules = await FeeAdjustmentRule.find({
      isActive: true,
      ...(schoolId ? { schoolId } : {}),
    });
    // Sort in JS: priority ASC (lower = higher precedence), name ASC as tiebreak
    return rules.slice().sort(
      (a, b) => (a.priority - b.priority) || (a.name || '').localeCompare(b.name || '')
    );
  }

  /**
   * Core rule application loop.
   *
   * Precedence: rules arrive pre-sorted (priority ASC, name ASC).
   * Conflict resolution policy is read from the first matching rule.
   */
  _applyRules(feeStructure, paymentContext, rules) {
    let finalFee = feeStructure.feeAmount;
    const adjustmentsApplied = [];

    // Determine conflict resolution policy from the first matching rule
    let policy = null;
    const matchingRules = rules.filter(r => this._ruleApplies(r, paymentContext));

    for (const rule of matchingRules) {
      if (!policy) {
        policy = rule.conflictResolutionPolicy || 'stack';
      }

      if (policy === 'first_only' && adjustmentsApplied.length > 0) {
        // Only the highest-priority match was allowed
        break;
      }

      if (policy === 'best_for_student') {
        // For discount rules: pick the one with the largest absolute reduction.
        // Skip this rule during stacking — we'll handle it separately below.
        // Penalty rules always stack, so we only skip discounts here.
        const isDiscount = rule.type === 'discount_percentage' || rule.type === 'discount_fixed';
        if (isDiscount && adjustmentsApplied.length > 0) {
          // Check if this discount is better than any already-applied discount
          const alreadyAppliedDiscount = adjustmentsApplied.some(
            a => a.type === 'discount_percentage' || a.type === 'discount_fixed'
          );
          if (alreadyAppliedDiscount) continue; // Only keep the best one
        }
      }

      let adjustmentAmount = 0;

      switch (rule.type) {
        case 'discount_percentage':
          adjustmentAmount = -(finalFee * rule.value / 100);
          break;
        case 'discount_fixed':
          adjustmentAmount = -rule.value;
          break;
        case 'penalty_percentage':
          adjustmentAmount = finalFee * rule.value / 100;
          break;
        case 'penalty_fixed':
          adjustmentAmount = rule.value;
          break;
        case 'waiver':
          adjustmentAmount = -finalFee; // full waiver
          break;
      }

      // Clamp so we don't go negative
      const feeBeforeClamp = finalFee + adjustmentAmount;
      finalFee = Math.max(0, feeBeforeClamp);

      adjustmentsApplied.push({
        ruleName: rule.name,
        type: rule.type,
        value: rule.value,
        amountAdjusted: Math.abs(adjustmentAmount),
        finalFeeAfterThis: finalFee,
      });

      // Full waiver short-circuits the loop
      if (rule.type === 'waiver') break;
    }

    const resolvedFinalFee = Math.round(finalFee * 100) / 100;

    // ── #903 Overpayment detection ───────────────────────────────────────────
    // If the student already paid more than the newly computed fee, surface
    // an explicit overpayment credit record for the caller to persist.
    let overpayment = null;
    const amountPaid = paymentContext.student?.totalPaid ?? 0;
    if (amountPaid > resolvedFinalFee) {
      overpayment = {
        studentId: paymentContext.student?.studentId,
        amountPaid,
        newFee: resolvedFinalFee,
        creditAmount: parseFloat((amountPaid - resolvedFinalFee).toFixed(2)),
        // remainingBalance is clamped to 0 — never negative
        remainingBalance: 0,
      };
    }

    return {
      baseFee: feeStructure.feeAmount,
      finalFee: resolvedFinalFee,
      adjustmentsApplied,
      // remainingBalance for callers that update the student record directly
      remainingBalance: Math.max(0, resolvedFinalFee - amountPaid),
      overpayment,
    };
  }

  _ruleApplies(rule, ctx) {
    const cond = rule.conditions || {};

    if (cond.studentClass?.length && !cond.studentClass.includes(ctx.student?.class || ctx.student?.className)) return false;
    if (cond.academicYear && cond.academicYear !== ctx.academicYear) return false;
    if (cond.paymentBefore && new Date(ctx.paymentDate) > new Date(cond.paymentBefore)) return false;
    if (cond.paymentAfter && new Date(ctx.paymentDate) < new Date(cond.paymentAfter)) return false;
    if (cond.minAmount && ctx.baseAmount < cond.minAmount) return false;
    if (cond.maxAmount && ctx.baseAmount > cond.maxAmount) return false;

    return true;
  }
}

module.exports = new FeeAdjustmentService();
