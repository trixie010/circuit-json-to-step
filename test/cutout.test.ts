// Fixtures:
//   cutout-polygon.json - slice of dataset-srj24/sample023 (real TI board,
//     3 polygon cutouts, 20-point outline).
//   cutout-circle-and-rect.json - circle and rounded-rect cutouts emitted by
//     @tscircuit/core, including a 90-degree panel tab. Only the bounding
//     pcb_board is synthetic.
import { test, expect } from "bun:test"
import type {
  CircuitJson,
  PcbBoard,
  PcbCutoutCircle,
  PcbCutoutPolygon,
  PcbCutoutRect,
  Point,
} from "circuit-json"
import { parseRepository, type EdgeLoop } from "stepts"
import { circuitJsonToStep } from "../lib/index"
import { fullCircleSegments, rotatePoint } from "../lib/pill-geometry"
import { importStepWithOcct } from "./utils/occt/importer"
import "./fixtures/step-snapshot"
import cutoutPolygon from "./fixtures/cutout-polygon.json"
import cutoutCircleAndRect from "./fixtures/cutout-circle-and-rect.json"

const polygonElements = cutoutPolygon as CircuitJson
const polygonBoard = polygonElements.find(
  (element): element is PcbBoard => element.type === "pcb_board",
)!
const polygonCutouts = polygonElements.filter(
  (element): element is PcbCutoutPolygon =>
    element.type === "pcb_cutout" && element.shape === "polygon",
)

function countOccurrences(text: string, token: string): number {
  return text.split(token).length - 1
}

function getLoopBreakCounts(stepText: string): number[] {
  const repo = parseRepository(stepText)
  const breakCounts: number[] = []

  for (const [, entity] of repo.entries()) {
    if (entity.type !== "EDGE_LOOP") continue
    const loop = entity as EdgeLoop
    const orientedEdges = loop.edges.map((edge) => edge.resolve(repo))
    let breaks = 0
    for (let index = 0; index < orientedEdges.length; index++) {
      const current = orientedEdges[index]!
      const next = orientedEdges[(index + 1) % orientedEdges.length]!
      const currentEdge = current.edge.resolve(repo)
      const nextEdge = next.edge.resolve(repo)
      const currentEnd = (
        current.orientation ? currentEdge.end : currentEdge.start
      ).resolve(repo)
      const nextStart = (
        next.orientation ? nextEdge.start : nextEdge.end
      ).resolve(repo)
      if (currentEnd !== nextStart) breaks++
    }
    breakCounts.push(breaks)
  }

  return breakCounts
}

function getMeshVolume(positions: number[], indices: number[]): number {
  let volume = 0
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i]! * 3
    const b = indices[i + 1]! * 3
    const c = indices[i + 2]! * 3
    volume +=
      (positions[a]! *
        (positions[b + 1]! * positions[c + 2]! -
          positions[b + 2]! * positions[c + 1]!) -
        positions[a + 1]! *
          (positions[b]! * positions[c + 2]! -
            positions[b + 2]! * positions[c]!) +
        positions[a + 2]! *
          (positions[b]! * positions[c + 1]! -
            positions[b + 1]! * positions[c]!)) /
      6
  }
  return volume
}

function polygonArea(points: Point[]): number {
  let area = 0
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length
    area += points[i]!.x * points[j]!.y - points[j]!.x * points[i]!.y
  }
  return Math.abs(area / 2)
}

function uniquePointCount(points: Point[]): number {
  let count = 0
  for (let i = 0; i < points.length; i++) {
    const previous = points[(i + points.length - 1) % points.length]!
    if (points[i]!.x !== previous.x || points[i]!.y !== previous.y) count++
  }
  return count
}

function getAxisExtents(
  positions: number[],
  axis: number,
): { min: number; max: number } {
  let lowest = Infinity
  let highest = -Infinity
  for (let index = axis; index < positions.length; index += 3) {
    const coordinate = positions[index]!
    lowest = Math.min(lowest, coordinate)
    highest = Math.max(highest, coordinate)
  }
  return { min: lowest, max: highest }
}

function toWorldPoint({
  offset,
  centerX,
  centerY,
  ccwRotationDegrees,
}: {
  offset: Point
  centerX: number
  centerY: number
  ccwRotationDegrees: number
}): Point {
  return rotatePoint({
    x: centerX + offset.x,
    y: centerY + offset.y,
    centerX,
    centerY,
    ccwRotationRadians: (ccwRotationDegrees * Math.PI) / 180,
  })
}

function probePoints(cutout: PcbCutoutCircle | PcbCutoutRect): Point[] {
  const centerX = cutout.center.x
  const centerY = cutout.center.y
  const ccwRotationDegrees =
    cutout.shape === "rect" ? (cutout.rotation ?? 0) : 0

  if (cutout.shape === "circle") {
    const probeRadius = cutout.radius * 0.35
    return [
      [0, 0],
      [probeRadius, probeRadius * 0.6],
      [-probeRadius, probeRadius * 0.6],
      [probeRadius, -probeRadius * 0.6],
      [-probeRadius, -probeRadius * 0.6],
    ].map(([x, y]) =>
      toWorldPoint({
        offset: { x: x!, y: y! },
        centerX,
        centerY,
        ccwRotationDegrees,
      }),
    )
  }

  const along = cutout.width * 0.3
  const across = cutout.height * 0.28
  return [
    [0, 0],
    [along, across],
    [-along, across],
    [along, -across],
    [-along, -across],
  ].map(([x, y]) =>
    toWorldPoint({
      offset: { x: x!, y: y! },
      centerX,
      centerY,
      ccwRotationDegrees,
    }),
  )
}

function getCutoutArea(cutout: PcbCutoutCircle | PcbCutoutRect): number {
  if (cutout.shape === "circle") {
    return Math.PI * cutout.radius * cutout.radius
  }
  const cornerRadius = cutout.corner_radius ?? 0
  return (
    cutout.width * cutout.height - (4 - Math.PI) * cornerRadius * cornerRadius
  )
}

function countCrossings({
  positions,
  indices,
  x,
  y,
}: {
  positions: number[]
  indices: number[]
  x: number
  y: number
}): number {
  let crossings = 0
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i]! * 3
    const b = indices[i + 1]! * 3
    const c = indices[i + 2]! * 3
    const ax = positions[a]!,
      ay = positions[a + 1]!,
      az = positions[a + 2]!
    const bx = positions[b]!,
      by = positions[b + 1]!,
      bz = positions[b + 2]!
    const cx = positions[c]!,
      cy = positions[c + 1]!,
      cz = positions[c + 2]!
    const e1x = bx - ax,
      e1y = by - ay,
      e1z = bz - az
    const e2x = cx - ax,
      e2y = cy - ay,
      e2z = cz - az
    // pvec = direction x e2 with direction (0, 0, -1) => (e2y, -e2x, 0)
    const hx = e2y,
      hy = -e2x,
      hz = 0
    const det = e1x * hx + e1y * hy + e1z * hz
    if (Math.abs(det) < 1e-12) continue
    const invDet = 1 / det
    const sx = x - ax,
      sy = y - ay,
      sz = 10 - az
    const u = (sx * hx + sy * hy + sz * hz) * invDet
    if (u < 0 || u > 1) continue
    const qx = sy * e1z - sz * e1y
    const qy = sz * e1x - sx * e1z
    const qz = sx * e1y - sy * e1x
    const v = -qz * invDet
    if (v < 0 || u + v > 1) continue
    const t = (e2x * qx + e2y * qy + e2z * qz) * invDet
    if (t > 0) crossings++
  }
  return crossings
}

test("cutout-polygon: cuts polygon cutouts out of a real 20-point board outline", async () => {
  const expectedSideFaces = uniquePointCount(polygonBoard.outline!)
  const expectedWallFaces = polygonCutouts.reduce(
    (total, cutout) => total + uniquePointCount(cutout.points),
    0,
  )
  const expectedFaces = 2 + expectedSideFaces + expectedWallFaces

  const stepText = await circuitJsonToStep(polygonElements, {
    exportMode: "pcb",
    productName: "CutoutPolygon",
  })

  expect(stepText).toContain("ISO-10303-21")
  expect(stepText).toContain("END-ISO-10303-21")
  expect(stepText).toContain("CutoutPolygon")
  expect(countOccurrences(stepText, "MANIFOLD_SOLID_BREP")).toBe(1)
  expect(countOccurrences(stepText, "CLOSED_SHELL")).toBe(1)
  expect(countOccurrences(stepText, "ADVANCED_FACE")).toBe(expectedFaces)
  expect(countOccurrences(stepText, "FACE_BOUND(")).toBe(
    polygonCutouts.length * 2,
  )
  expect(getLoopBreakCounts(stepText).filter((count) => count > 0)).toEqual([])

  const occtResult = await importStepWithOcct(stepText)
  expect(occtResult.success).toBe(true)
  expect(occtResult.meshes.length).toBe(1)
  expect(occtResult.meshes[0]!.brep_faces.length).toBe(expectedFaces)

  const boardArea = polygonArea(polygonBoard.outline!)
  const totalCutoutArea = polygonCutouts.reduce(
    (total, cutout) => total + polygonArea(cutout.points),
    0,
  )
  expect(totalCutoutArea).toBeGreaterThan(0)
  expect(totalCutoutArea).toBeLessThan(boardArea)
  expect((boardArea - totalCutoutArea) * polygonBoard.thickness).toBeCloseTo(
    566.1029634967914,
    4,
  )

  const mesh = occtResult.meshes[0]!
  const positions = mesh.attributes.position.array
  const volume = getMeshVolume(positions, mesh.index.array)
  expect(volume).toBeCloseTo(
    (boardArea - totalCutoutArea) * polygonBoard.thickness,
    4,
  )

  const extents = [0, 1, 2].map((axis) => getAxisExtents(positions, axis))
  expect(extents[0]!.min).toBeCloseTo(17.5264, 4)
  expect(extents[0]!.max).toBeCloseTo(47.9272, 4)
  expect(extents[1]!.min).toBeCloseTo(38.5132, 4)
  expect(extents[1]!.max).toBeCloseTo(59.414, 4)
  expect(extents[2]!.min).toBeCloseTo(-0.8, 4)
  expect(extents[2]!.max).toBeCloseTo(0.8, 4)

  await expect(stepText).toMatchStepSnapshot(import.meta.path, "cutout")
}, 20000)

test("cutout-circle-and-rect: circle and panel-tab cutouts remove material", async () => {
  const shapeElements = cutoutCircleAndRect as CircuitJson
  const boardElement = shapeElements.find(
    (element): element is PcbBoard => element.type === "pcb_board",
  )!
  const cutoutElements = shapeElements.filter(
    (element): element is PcbCutoutCircle | PcbCutoutRect =>
      element.type === "pcb_cutout" &&
      element.shape !== "polygon" &&
      element.shape !== "path",
  )

  const boardVolume =
    boardElement.width! * boardElement.height! * boardElement.thickness

  expect(cutoutElements.length).toBe(4)
  expect(
    cutoutElements.filter((cutout) => cutout.shape === "circle").length,
  ).toBe(2)
  expect(
    cutoutElements.filter(
      (cutout) => cutout.shape === "rect" && (cutout.corner_radius ?? 0) > 0,
    ).length,
  ).toBe(2)
  for (const cutout of cutoutElements) {
    const stepText = await circuitJsonToStep([boardElement, cutout], {
      exportMode: "pcb",
    })
    expect(getLoopBreakCounts(stepText).filter((count) => count > 0)).toEqual(
      [],
    )

    const occtResult = await importStepWithOcct(stepText)
    expect(occtResult.success).toBe(true)
    const mesh = occtResult.meshes[0]!
    const removed =
      boardVolume -
      getMeshVolume(mesh.attributes.position.array, mesh.index.array)

    // Curved walls are tessellated, so removal is bounded below by the
    // analytic volume and must never exceed it.
    const analyticRemovedVolume = getCutoutArea(cutout) * boardElement.thickness
    expect(removed).toBeGreaterThan(analyticRemovedVolume * 0.4)
    expect(removed).toBeLessThanOrEqual(analyticRemovedVolume)
  }

  const combinedStepText = await circuitJsonToStep(shapeElements, {
    exportMode: "pcb",
    productName: "CutoutShapes",
  })
  expect(countOccurrences(combinedStepText, "MANIFOLD_SOLID_BREP")).toBe(1)
  expect(countOccurrences(combinedStepText, "FACE_BOUND(")).toBe(8)
  expect(
    getLoopBreakCounts(combinedStepText).filter((count) => count > 0),
  ).toEqual([])

  // Board faces: top, bottom, 4 sides. A circle contributes fullCircleSegments
  // walls; a stadium tab contributes 4 (2 straight runs and 2 half-arcs).
  const circleWalls =
    cutoutElements.filter((cutout) => cutout.shape === "circle").length *
    fullCircleSegments
  const stadiumWalls =
    cutoutElements.filter((cutout) => cutout.shape === "rect").length * 4
  const advancedFaces = countOccurrences(combinedStepText, "ADVANCED_FACE")
  expect(advancedFaces).toBe(6 + circleWalls + stadiumWalls)

  // Refine the mesh so the small cylindrical walls are tessellated finely enough
  // for the coverage probe; the STEP topology is already exact.
  const occtCombined = await importStepWithOcct(combinedStepText, {
    linearUnit: "millimeter",
    linearDeflectionType: "absolute_value",
    linearDeflection: 0.01,
    angularDeflection: 0.05,
  })
  expect(occtCombined.success).toBe(true)
  const mesh = occtCombined.meshes[0]!
  expect(mesh.brep_faces.length).toBe(advancedFaces)

  // Cast a vertical ray at probe points instead of integrating volume: occt's
  // tessellator winds identical solids differently, so divergence volume varies
  // while ray crossings do not. Zero crossings means the ray passed through a
  // cutout; any non-zero count means it entered and exited material.
  const positions = mesh.attributes.position.array
  const indices = mesh.index.array

  for (const cutout of cutoutElements) {
    for (const probe of probePoints(cutout)) {
      expect({
        cutout: cutout.pcb_cutout_id,
        ...probe,
        crossings: countCrossings({
          positions,
          indices,
          x: probe.x,
          y: probe.y,
        }),
      }).toEqual({ cutout: cutout.pcb_cutout_id, ...probe, crossings: 0 })
    }
  }

  for (const probe of [
    { x: -25, y: 3 },
    { x: -15, y: 3 },
    { x: -5, y: 3 },
    { x: 3, y: 3 },
    { x: -26, y: -3 },
    { x: -12, y: -3 },
    { x: 3, y: -3 },
  ]) {
    expect(
      countCrossings({ positions, indices, x: probe.x, y: probe.y }),
    ).toBeGreaterThan(0)
  }
}, 20000)
