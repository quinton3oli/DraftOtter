// Mass properties of world-space triangle meshes: volume, surface area, center of mass and whether the part
// stands stably on the bed (center of mass over its footprint).
import * as THREE from 'three';

/** geoms: non-indexed world BufferGeometries (closed, outward-facing). */
export function massProps(geoms) {
	let vol = 0, area = 0, cx = 0, cy = 0, cz = 0, minZ = Infinity;
	for (const g of geoms) {
		const p = g.attributes.position.array;
		for (let i = 0; i < p.length; i += 9) {
			const ax = p[i], ay = p[i + 1], az = p[i + 2], bx = p[i + 3], by = p[i + 4], bz = p[i + 5], qx = p[i + 6], qy = p[i + 7], qz = p[i + 8];
			// signed tetra volume with the origin
			const v = (ax * (by * qz - bz * qy) - ay * (bx * qz - bz * qx) + az * (bx * qy - by * qx)) / 6;
			vol += v;
			cx += v * (ax + bx + qx) / 4; cy += v * (ay + by + qy) / 4; cz += v * (az + bz + qz) / 4;
			const ux = bx - ax, uy = by - ay, uz = bz - az, wx = qx - ax, wy = qy - ay, wz = qz - az;
			area += Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx) / 2;
			minZ = Math.min(minZ, az, bz, qz);
		}
	}
	if (!(Math.abs(vol) > 1e-9)) return null;
	const com = new THREE.Vector3(cx / vol, cy / vol, cz / vol);
	// footprint: convex hull of the points touching the lowest level
	const pts = [];
	for (const g of geoms) {
		const p = g.attributes.position.array;
		for (let i = 0; i < p.length; i += 3) if (p[i + 2] < minZ + 0.05) pts.push([p[i], p[i + 1]]);
	}
	const hull = convexHull2(pts);
	const margin = hull.length >= 3 ? insideMargin([com.x, com.y], hull) : -Infinity;
	return { volume: Math.abs(vol), area, com, minZ, footprint: hull, margin, stable: margin > 0.5 };
}

/** Andrew's monotone chain; returns CCW hull. */
export function convexHull2(points) {
	const p = [...new Map(points.map((q) => [Math.round(q[0] * 1e4) + ',' + Math.round(q[1] * 1e4), q])).values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	if (p.length < 3) return p;
	const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
	const lower = [], upper = [];
	for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 1e-12) lower.pop(); lower.push(q); }
	for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 1e-12) upper.pop(); upper.push(q); }
	upper.pop(); lower.pop();
	return lower.concat(upper);
}

/** Signed distance from a point to the boundary of a CCW convex polygon (positive inside). */
function insideMargin(q, hull) {
	let m = Infinity;
	for (let i = 0; i < hull.length; i++) {
		const a = hull[i], b = hull[(i + 1) % hull.length];
		const ex = b[0] - a[0], ey = b[1] - a[1], L = Math.hypot(ex, ey) || 1e-12;
		m = Math.min(m, (ex * (q[1] - a[1]) - ey * (q[0] - a[0])) / L); // CCW: inside is to the left of every edge
	}
	return m;
}
