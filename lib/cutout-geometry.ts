import type { PcbCutout, Point } from "circuit-json"
import type { Ref, Repository } from "stepts"
import {
  AdvancedFace,
  Axis2Placement3D,
  CartesianPoint,
  CylindricalSurface,
  Direction,
  EdgeCurve,
  EdgeLoop,
  FaceOuterBound,
  OrientedEdge,
  Plane,
  VertexPoint,
} from "stepts"
import {
  createArcSegment,
  createLineEdge,
  createLineSegment,
  createLoopFromSegments,
  createWallFaces,
  createVertexCache,
  fullCircleSegments,
  rotatePoint,
  type PillBoundarySegment,
} from "./pill-geometry"

interface CutoutGeometry {
  bottomLoop: Ref<EdgeLoop>
  topLoop: Ref<EdgeLoop>
  wallFaces: Ref<AdvancedFace>[]
}

function isFiniteNumber(candidate: unknown): candidate is number {
  return typeof candidate === "number" && Number.isFinite(candidate)
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180
}

function createSegmentedCutoutGeometry({
  repo,
  createSegments,
  zMin,
  zMax,
  zDir,
}: {
  repo: Repository
  createSegments: (
    z: number,
    getVertex: (x: number, y: number) => Ref<VertexPoint>,
  ) => PillBoundarySegment[]
  zMin: number
  zMax: number
  zDir: Ref<Direction>
}): CutoutGeometry {
  const bottomSegments = createSegments(zMin, createVertexCache(repo, zMin))
  const topSegments = createSegments(zMax, createVertexCache(repo, zMax))
  const bottomLoop = createLoopFromSegments({
    repo,
    segments: bottomSegments,
  })
  const topLoop = createLoopFromSegments({
    repo,
    segments: topSegments,
  })
  const wallFaces = createWallFaces({
    repo,
    bottomSegments,
    topSegments,
    zMin,
    zDir,
  })

  return { bottomLoop, topLoop, wallFaces }
}

function createCircleCutoutGeometry({
  repo,
  centerX,
  centerY,
  radius,
  zMin,
  zMax,
  zDir,
}: {
  repo: Repository
  centerX: number
  centerY: number
  radius: number
  zMin: number
  zMax: number
  zDir: Ref<Direction>
}): CutoutGeometry {
  // Build from arcs rather than one closed CIRCLE edge: occt fans a full
  // cylindrical face across the seam, which under-measures the removal.
  const segmentCount = fullCircleSegments
  const fullTurn = Math.PI * 2

  return createSegmentedCutoutGeometry({
    repo,
    createSegments: (z, getVertex) => {
      const arcs: PillBoundarySegment[] = []
      for (let index = 0; index < segmentCount; index++) {
        arcs.push(
          createArcSegment({
            repo,
            centerX,
            centerY,
            z,
            radius,
            startAngle: (index * fullTurn) / segmentCount,
            endAngle: ((index + 1) * fullTurn) / segmentCount,
            ccwRotationRadians: 0,
            rotationCenterX: centerX,
            rotationCenterY: centerY,
            getVertex,
          }),
        )
      }
      return arcs
    },
    zMin,
    zMax,
    zDir,
  })
}

function createRectCutoutGeometry({
  repo,
  centerX,
  centerY,
  width,
  height,
  cornerRadius,
  ccwRotationRadians,
  zMin,
  zMax,
  zDir,
}: {
  repo: Repository
  centerX: number
  centerY: number
  width: number
  height: number
  cornerRadius: number
  ccwRotationRadians: number
  zMin: number
  zMax: number
  zDir: Ref<Direction>
}): CutoutGeometry {
  const halfWidth = width / 2
  const halfHeight = height / 2
  const radius = Math.min(cornerRadius, halfWidth, halfHeight)
  const straightHalfWidth = halfWidth - radius
  const straightHalfHeight = halfHeight - radius
  const quarter = Math.PI / 2

  return createSegmentedCutoutGeometry({
    repo,
    createSegments: (z, getVertex) => {
      if (radius <= 0) {
        const corners = [
          { x: centerX - halfWidth, y: centerY - halfHeight },
          { x: centerX + halfWidth, y: centerY - halfHeight },
          { x: centerX + halfWidth, y: centerY + halfHeight },
          { x: centerX - halfWidth, y: centerY + halfHeight },
        ].map((corner) =>
          rotatePoint({
            x: corner.x,
            y: corner.y,
            centerX,
            centerY,
            ccwRotationRadians,
          }),
        )
        return corners.map((corner, index) =>
          createLineSegment({
            repo,
            start: corner,
            end: corners[(index + 1) % corners.length]!,
            getVertex,
          }),
        )
      }

      // A corner radius at half the side length collapses that side's straight
      // run. Panel tabs hit this, so each end becomes one half-circle instead
      // of two quarters joined by a zero-length line.
      const hasHorizontalRun = straightHalfWidth > 0
      const hasVerticalRun = straightHalfHeight > 0

      const segments: PillBoundarySegment[] = []

      if (hasHorizontalRun) {
        segments.push(
          createLineSegment({
            repo,
            start: rotatePoint({
              x: centerX - straightHalfWidth,
              y: centerY - halfHeight,
              centerX,
              centerY,
              ccwRotationRadians,
            }),
            end: rotatePoint({
              x: centerX + straightHalfWidth,
              y: centerY - halfHeight,
              centerX,
              centerY,
              ccwRotationRadians,
            }),
            getVertex,
          }),
        )
      }

      if (hasVerticalRun) {
        segments.push(
          createArcSegment({
            repo,
            centerX: centerX + straightHalfWidth,
            centerY: centerY - straightHalfHeight,
            z,
            radius,
            startAngle: quarter * 3,
            endAngle: quarter * 4,
            ccwRotationRadians,
            rotationCenterX: centerX,
            rotationCenterY: centerY,
            getVertex,
          }),
          createLineSegment({
            repo,
            start: rotatePoint({
              x: centerX + halfWidth,
              y: centerY - straightHalfHeight,
              centerX,
              centerY,
              ccwRotationRadians,
            }),
            end: rotatePoint({
              x: centerX + halfWidth,
              y: centerY + straightHalfHeight,
              centerX,
              centerY,
              ccwRotationRadians,
            }),
            getVertex,
          }),
          createArcSegment({
            repo,
            centerX: centerX + straightHalfWidth,
            centerY: centerY + straightHalfHeight,
            z,
            radius,
            startAngle: 0,
            endAngle: quarter,
            ccwRotationRadians,
            rotationCenterX: centerX,
            rotationCenterY: centerY,
            getVertex,
          }),
        )
      } else {
        segments.push(
          createArcSegment({
            repo,
            centerX: centerX + straightHalfWidth,
            centerY,
            z,
            radius,
            startAngle: quarter * 3,
            endAngle: quarter * 5,
            ccwRotationRadians,
            rotationCenterX: centerX,
            rotationCenterY: centerY,
            getVertex,
          }),
        )
      }

      if (hasHorizontalRun) {
        segments.push(
          createLineSegment({
            repo,
            start: rotatePoint({
              x: centerX + straightHalfWidth,
              y: centerY + halfHeight,
              centerX,
              centerY,
              ccwRotationRadians,
            }),
            end: rotatePoint({
              x: centerX - straightHalfWidth,
              y: centerY + halfHeight,
              centerX,
              centerY,
              ccwRotationRadians,
            }),
            getVertex,
          }),
        )
      }

      if (hasVerticalRun) {
        segments.push(
          createArcSegment({
            repo,
            centerX: centerX - straightHalfWidth,
            centerY: centerY + straightHalfHeight,
            z,
            radius,
            startAngle: quarter,
            endAngle: quarter * 2,
            ccwRotationRadians,
            rotationCenterX: centerX,
            rotationCenterY: centerY,
            getVertex,
          }),
          createLineSegment({
            repo,
            start: rotatePoint({
              x: centerX - halfWidth,
              y: centerY + straightHalfHeight,
              centerX,
              centerY,
              ccwRotationRadians,
            }),
            end: rotatePoint({
              x: centerX - halfWidth,
              y: centerY - straightHalfHeight,
              centerX,
              centerY,
              ccwRotationRadians,
            }),
            getVertex,
          }),
          createArcSegment({
            repo,
            centerX: centerX - straightHalfWidth,
            centerY: centerY - straightHalfHeight,
            z,
            radius,
            startAngle: quarter * 2,
            endAngle: quarter * 3,
            ccwRotationRadians,
            rotationCenterX: centerX,
            rotationCenterY: centerY,
            getVertex,
          }),
        )
      } else {
        segments.push(
          createArcSegment({
            repo,
            centerX: centerX - straightHalfWidth,
            centerY,
            z,
            radius,
            startAngle: quarter,
            endAngle: quarter * 3,
            ccwRotationRadians,
            rotationCenterX: centerX,
            rotationCenterY: centerY,
            getVertex,
          }),
        )
      }

      return segments
    },
    zMin,
    zMax,
    zDir,
  })
}

function signedArea(points: Point[]): number {
  let area = 0
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length
    area += points[i]!.x * points[j]!.y - points[j]!.x * points[i]!.y
  }
  return area / 2
}

function isSamePoint(a: Point, b: Point): boolean {
  const dx = b.x - a.x
  const dy = b.y - a.y
  return Math.sqrt(dx * dx + dy * dy) <= 1e-6
}

function dropRepeatedPoints(points: Point[]): Point[] {
  const unique: Point[] = []
  for (const point of points) {
    const previous = unique[unique.length - 1]
    if (previous && isSamePoint(previous, point)) {
      continue
    }
    unique.push({ x: point.x, y: point.y })
  }
  while (
    unique.length > 1 &&
    isSamePoint(unique[0]!, unique[unique.length - 1]!)
  ) {
    unique.pop()
  }
  return unique
}

function createPolygonCutoutGeometry({
  repo,
  points,
  zMin,
  zMax,
  zDir,
}: {
  repo: Repository
  points: Point[]
  zMin: number
  zMax: number
  zDir: Ref<Direction>
}): CutoutGeometry {
  const vertices = dropRepeatedPoints(points)
  if (signedArea(vertices) < 0) {
    vertices.reverse()
  }

  return createSegmentedCutoutGeometry({
    repo,
    createSegments: (z, getVertex) =>
      vertices.map((point, index) =>
        createLineSegment({
          repo,
          start: point,
          end: vertices[(index + 1) % vertices.length]!,
          getVertex,
        }),
      ),
    zMin,
    zMax,
    zDir,
  })
}

export function createCutoutGeometry({
  repo,
  cutout,
  zMin,
  zMax,
  zDir,
}: {
  repo: Repository
  cutout: PcbCutout
  zMin: number
  zMax: number
  zDir: Ref<Direction>
}): CutoutGeometry | null {
  if (cutout.shape === "circle") {
    const centerX = cutout.center?.x
    const centerY = cutout.center?.y
    if (!isFiniteNumber(centerX) || !isFiniteNumber(centerY)) return null
    if (!isFiniteNumber(cutout.radius) || cutout.radius <= 0) return null
    return createCircleCutoutGeometry({
      repo,
      centerX,
      centerY,
      radius: cutout.radius,
      zMin,
      zMax,
      zDir,
    })
  }

  if (cutout.shape === "rect") {
    const centerX = cutout.center?.x
    const centerY = cutout.center?.y
    if (!isFiniteNumber(centerX) || !isFiniteNumber(centerY)) return null
    if (!isFiniteNumber(cutout.width) || cutout.width <= 0) return null
    if (!isFiniteNumber(cutout.height) || cutout.height <= 0) return null
    const cornerRadius = isFiniteNumber(cutout.corner_radius)
      ? cutout.corner_radius
      : 0
    const ccwRotationRadians = isFiniteNumber(cutout.rotation)
      ? toRadians(cutout.rotation)
      : 0
    return createRectCutoutGeometry({
      repo,
      centerX,
      centerY,
      width: cutout.width,
      height: cutout.height,
      cornerRadius,
      ccwRotationRadians,
      zMin,
      zMax,
      zDir,
    })
  }

  if (cutout.shape === "polygon") {
    if (!Array.isArray(cutout.points)) return null
    const points = cutout.points.filter(
      (point): point is Point =>
        isFiniteNumber(point?.x) && isFiniteNumber(point?.y),
    )
    if (points.length < 3) return null
    return createPolygonCutoutGeometry({
      repo,
      points,
      zMin,
      zMax,
      zDir,
    })
  }

  return null
}
