'use strict';

const mongoose = require('mongoose');
const feeAdjustmentController = require('../src/controllers/feeAdjustmentController');
const feeAdjustmentService = require('../src/services/feeAdjustmentService');
const FeeAdjustmentRule = require('../src/models/feeAdjustmentRuleModel');
const Student = require('../src/models/studentModel');

describe('Fee Adjustment Performance & Cohort Scaling (#1189)', () => {
  const schoolId = 'SCH_PERF_1001';
  let mockStudents;
  let mockRules;

  beforeEach(() => {
    jest.clearAllMocks();

    // Create a 5,000 student synthetic cohort
    mockStudents = Array.from({ length: 5000 }, (_, i) => ({
      _id: new mongoose.Types.ObjectId(),
      schoolId,
      studentId: `STU_${100000 + i}`,
      name: `Student ${i}`,
      class: 'JSS1',
      academicYear: '2026',
      feeAmount: 1000,
      totalPaid: i % 10 === 0 ? 950 : 0,
      feePaid: false,
      deletedAt: null,
    }));

    mockRules = [
      {
        _id: new mongoose.Types.ObjectId(),
        schoolId,
        name: 'Early Bird Discount',
        type: 'discount_percentage',
        value: 10,
        priority: 5,
        conflictResolutionPolicy: 'stack',
        isActive: true,
      },
    ];

    // Mock Student.find
    jest.spyOn(Student, 'find').mockReturnValue({
      lean: jest.fn().mockResolvedValue(mockStudents),
    });

    // Mock FeeAdjustmentRule.find
    jest.spyOn(FeeAdjustmentRule, 'find').mockImplementation(() => {
      return {
        sort: jest.fn().mockResolvedValue(mockRules),
        exec: jest.fn().mockResolvedValue(mockRules),
        then: (cb) => Promise.resolve(mockRules).then(cb),
      };
    });

    // Mock feeAdjustmentService.fetchSortedRules
    jest.spyOn(feeAdjustmentService, 'fetchSortedRules').mockResolvedValue(mockRules);

    // Mock Student.bulkWrite
    jest.spyOn(Student, 'bulkWrite').mockResolvedValue({ ok: 1, nModified: 5000 });

    // Mock mongoose session transaction
    jest.spyOn(mongoose, 'startSession').mockResolvedValue({
      withTransaction: jest.fn().mockImplementation(async (cb) => cb()),
      endSession: jest.fn(),
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('dryRunRule Benchmark', () => {
    it('should complete dry-run for 5,000 students within bounded time and avoid N+1 DB calls', async () => {
      const req = {
        schoolId,
        body: {
          rule: {
            name: 'Special Promo',
            type: 'discount_fixed',
            value: 50,
            priority: 1,
            conflictResolutionPolicy: 'stack',
          },
          studentClass: 'JSS1',
          academicYear: '2026',
        },
      };

      let responseData = null;
      const res = {
        json: jest.fn((data) => {
          responseData = data;
        }),
      };
      const next = jest.fn();

      const startTime = Date.now();
      await feeAdjustmentController.dryRunRule(req, res, next);
      const durationMs = Date.now() - startTime;

      expect(next).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledTimes(1);

      // Verify N+1 avoidance: fetchSortedRules called only 1 time for the entire batch
      expect(feeAdjustmentService.fetchSortedRules).toHaveBeenCalledTimes(1);
      expect(feeAdjustmentService.fetchSortedRules).toHaveBeenCalledWith(schoolId);

      // Assert cohort performance bounded threshold (< 3000ms for 5,000 students)
      expect(durationMs).toBeLessThan(3000);

      // Assert correctness of calculations
      expect(responseData.summary.totalStudents).toBe(5000);
      expect(responseData.summary.affectedStudents).toBe(5000);
      expect(responseData.previews.length).toBe(5000);
      // Priority 1 fixed discount of 50 -> fee 950. Priority 5 percentage discount 10% -> 855
      expect(responseData.previews[0].projectedFee).toBe(855);
    });
  });

  describe('applyRule Benchmark', () => {
    it('should complete apply rule for 5,000 students within bounded time and execute chunked bulk writes', async () => {
      const ruleId = new mongoose.Types.ObjectId();
      const mockRuleToApply = {
        _id: ruleId,
        schoolId,
        name: 'Early Bird Discount',
        type: 'discount_percentage',
        value: 10,
        priority: 5,
        conflictResolutionPolicy: 'stack',
        isActive: true,
      };

      jest.spyOn(FeeAdjustmentRule, 'findOne').mockResolvedValue(mockRuleToApply);

      const req = {
        params: { id: String(ruleId) },
        schoolId,
        body: {
          studentClass: 'JSS1',
          academicYear: '2026',
        },
      };

      let responseData = null;
      const res = {
        json: jest.fn((data) => {
          responseData = data;
        }),
      };
      const next = jest.fn();

      const startTime = Date.now();
      await feeAdjustmentController.applyRule(req, res, next);
      const durationMs = Date.now() - startTime;

      expect(next).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledTimes(1);

      // Verify N+1 avoidance: rule fetching called only 1 time
      expect(feeAdjustmentService.fetchSortedRules).toHaveBeenCalledTimes(1);

      // Assert performance threshold for 5,000 students (< 3000ms)
      expect(durationMs).toBeLessThan(3000);

      // Verify Student.bulkWrite called in chunks of 1000 (5 chunks for 5000 updates)
      expect(Student.bulkWrite).toHaveBeenCalledTimes(5);

      expect(responseData.status).toBe('completed');
      expect(responseData.studentsProcessed).toBe(5000);
      expect(responseData.studentsUpdated).toBe(5000);
    });
  });
});
