/**
 * Example test file demonstrating test setup.
 */
describe("Example Test Suite", () => {
  it("should pass a basic test", () => {
    expect(1 + 1).toBe(2);
  });

  it("should handle arrays", () => {
    const items = [1, 2, 3];
    expect(items).toHaveLength(3);
    expect(items).toContain(2);
  });

  it("should handle objects", () => {
    const obj = { name: "test", value: 42 };
    expect(obj).toHaveProperty("name", "test");
    expect(obj.value).toBeGreaterThan(0);
  });
});
